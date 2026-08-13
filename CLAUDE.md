# CLAUDE.md — Engineering Context for This Repository

This file is persistent context for any Claude Code / Claude session working in this
repository. Read it before making changes. It summarizes and points to the fuller docs in
`docs/`; when this file and a doc in `docs/` disagree, the doc is more likely to be current —
fix this file to match and say so.

## What this project is

A personal financial reconciliation system. It is **not** an expense tracker, budgeting app,
receipt scanner, or Splitwise replacement — see `docs/product/overview.md` for the full
problem statement. The one-line version: turn messy financial evidence into a verified,
explainable ledger that says who benefited from every payment and who owes whom.

The conceptual pipeline, always in this order and never collapsed:

```
PAYMENT → PURPOSE → EVIDENCE → EXPENSE → BENEFICIARIES → ALLOCATION → SETTLEMENT → RECONCILIATION
```

Full entity definitions: `docs/domain/domain-model.md`. Glossary: `docs/domain/terminology.md`.

## Non-negotiable domain principles

1. **Payment ≠ Expense ≠ Receipt.** A single payment may fund multiple expenses. A single
   expense may have multiple beneficiaries. A single occasion may span multiple payments.
   Never model these as the same object or assume a 1:1 relationship.
2. **Evidence is immutable.** Raw imported financial data (a bank statement line, a UPI
   notification, a receipt image) is never overwritten by an interpretation of it. Corrections
   produce new derived records; they do not mutate the source.
3. **Evidence → Inference → Decision are distinct and traceable.** What the source says
   (evidence) is not what the system believes it means (inference) is not what the user has
   approved (decision). Every financially consequential record should be able to answer which
   of the three it is.
4. **AI is an inference engine, not a source of truth.** See "AI boundary" below — this is the
   single most important rule in the codebase.
5. **Shared expenses are not a boolean.** `is_shared = true` is not an acceptable
   representation. Model explicit allocations with a method (equal, exact, percentage,
   item-based, quantity-based, custom) and explicit beneficiaries.
6. **Splitwise is an external sync target.** This application's own ledger is the canonical
   source of truth. Splitwise identifiers are stored for traceability; Splitwise's numbers are
   reconciled against, never trusted blindly.
7. **Unexplained money is a first-class concept**, not a bug to hide. The system should always
   be able to show `total outflow − transfers − investments − explained expenses =
unexplained`, and surface that number rather than making it disappear through silent
   assumptions.

Full invariant list (with the "why" for each): `docs/domain/invariants.md`.

## AI boundary — read this before touching anything AI-related

- Deterministic application code owns: arithmetic, totals, rounding, percentages,
  allocations, balances, settlement calculations, reconciliation, state transitions,
  validation, and deduplication wherever the evidence is deterministic.
- AI owns: semantic transaction classification, merchant interpretation, receipt/item
  extraction, beneficiary suggestions, allocation suggestions, grouping into occasions,
  anomaly explanation, rule proposals, and natural-language interaction.
- AI output is always a **structured proposal** with a **confidence level**
  (`high | medium | low | unknown`). The application validates proposals before they can
  become state. An LLM must never directly write an authoritative balance, total, allocation,
  or settlement.
- Ambiguous, financially consequential decisions require explicit human approval — high
  confidence does not waive this when the amount or the beneficiary set is uncertain.
- See `docs/architecture/ai-boundary.md` for the concrete service interface
  (`classifyTransaction`, `suggestAllocation`, etc.) and validation contract.

## Financial safety rules

- All authoritative financial arithmetic lives in `src/domain` (or `src/services` calling into
  it) as plain, deterministic, unit-tested TypeScript. Never in a UI component, never behind an
  LLM call, never computed twice in two places.
- Rounding must be deterministic and documented at the point it happens (see
  `docs/domain/invariants.md` for the rounding rule once finalized in implementation).
- Transfers between the user's own accounts are not expenses and must never be counted as
  spending.
- Refunds (full or partial) must net against the original expense, not appear as unrelated
  income.
- Duplicate transactions must not double-count money; deduplication logic must be deterministic
  wherever the evidence allows it, with AI assistance only for ambiguous cases requiring human
  confirmation.
- Every financial amount must be traceable back to its source evidence record.
- Every change to important financial data must be auditable: timestamp, actor, old value, new
  value, source, reason, and (if AI-assisted) model/confidence information.
- Approved financial decisions do not silently change. Re-deriving a suggestion never
  overwrites a user's prior approval without a new, visible decision.

## Repository conventions

- **Language/stack**: TypeScript (strict mode), Node.js 20+. See
  `docs/architecture/system-architecture.md` for the full stack decision and rationale.
- **Structure**: `src/domain`, `src/services`, `src/ai`, `src/db`, `src/integrations`,
  `src/api` — each has its own `README.md` describing its responsibility. Domain logic must
  not import from `api` or `integrations`; dependencies point inward toward `domain`.
- **No secrets in Git.** Real bank statements, receipts, UPI identifiers, account numbers,
  card numbers, API keys, tokens, and production credentials must never be committed. Use
  `.env` (gitignored) locally; `.env.example` documents required variables with empty values.
- **No real financial data in fixtures.** Everything in `fixtures/` is synthetic. See
  `fixtures/README.md`.
- **Small, composable modules.** Avoid speculative abstraction, premature optimization, giant
  files, hidden business logic, and tight coupling to any one bank, merchant, or to Splitwise.
- **Explicit state transitions.** Transaction/expense lifecycle states are modeled explicitly
  (see `docs/domain/lifecycle.md`), not inferred from a combination of flags.
- **Architecture decisions are recorded.** Non-trivial technical or domain decisions get an ADR
  in `docs/decisions/`. See `docs/decisions/README.md` for the process.

## Testing requirements

- Financial calculations (allocation, settlement, rounding, refunds, deduplication,
  reconciliation) require deterministic automated tests before they ship — no exceptions, and
  no "trust the AI output" shortcut.
- Tests use synthetic fixtures from `fixtures/`, never real user data.
- Full strategy, including what test types apply to which layer and the coverage bar for
  financial code: `docs/testing/testing-strategy.md`.
- Before committing: `npm run typecheck && npm run lint && npm run format:check && npm test`
  must all pass. CI enforces the same on every push/PR.

## Development workflow

- This project moves in **incremental vertical slices** — see `docs/roadmap.md` for the
  phase order (repository foundation → domain model → architecture → database model →
  fixtures → import → normalization → classification → human review → receipt ingestion →
  item extraction → beneficiary allocation → expense ledger → Splitwise integration →
  reconciliation → rules/learning → analytics → natural-language interface).
- **Do not jump ahead of the current phase.** Building later-phase features before earlier
  ones are solid re-creates the exact "messy, unreconciled" problem this system exists to
  solve, just in code form.
- Do not connect real bank accounts, real Splitwise accounts, or use real financial
  credentials during development. Build adapters/interfaces now; wire real connections later,
  deliberately, per `docs/security/security-model.md`.
- Do not invest in UI polish until the domain and financial engine are solid. A placeholder UI
  is fine when a framework requires one.

## Where things live

| Topic                         | Doc                                        |
| ----------------------------- | ------------------------------------------ |
| Product problem & vision      | `docs/product/overview.md`                 |
| Detailed requirements         | `docs/product/requirements.md`             |
| Domain entities               | `docs/domain/domain-model.md`              |
| Glossary                      | `docs/domain/terminology.md`               |
| Invariants                    | `docs/domain/invariants.md`                |
| State lifecycle               | `docs/domain/lifecycle.md`                 |
| Scenario stress-tests         | `docs/domain/scenario-analysis.md`         |
| System architecture           | `docs/architecture/system-architecture.md` |
| Data flow                     | `docs/architecture/data-flow.md`           |
| AI service boundary           | `docs/architecture/ai-boundary.md`         |
| Database design               | `docs/architecture/database-design.md`     |
| Architecture Decision Records | `docs/decisions/`                          |
| Testing strategy              | `docs/testing/testing-strategy.md`         |
| Security model                | `docs/security/security-model.md`          |
| Roadmap / current phase       | `docs/roadmap.md`                          |
