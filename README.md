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

**Built, and exercised end to end on synthetic data — not yet connected to anything live.** All
twenty-two numbered phases and the capabilities that followed them (ADRs 0051–0057) are
implemented, and a person can reach them from the website in `web/`: add a statement, answer what
the system could not decide, share an expense, and read spending and who owes whom, each figure
traceable to the records behind it.

What the 5 October 2026 readiness verification actually showed — scope stated, not assumed
(full figures, defects and gaps in
[`docs/testing/readiness-verification-2026-10-05.md`](docs/testing/readiness-verification-2026-10-05.md)):

- **Demonstrated, through the rendered website, on a synthetic ledger:** CSV import in one bank
  export layout and a synthetic IDFC FIRST credit-card PDF; duplicate and overlapping imports;
  confirming categories and duplicates; an imported dinner approved as _shared_ and allocated
  into a real debt; an expense the owner paid and one somebody else paid; a deferred duplicate
  that could not be counted twice; Spending and People figures matching independently calculated totals; the same
  figures after restarting the API; desktop and phone widths. A CSV whose columns fit two layouts
  (for example `date,description,amount_inr,type,reference`) is imported by _choosing_ the layout
  in the dialog — nothing preselected, the API's own totals shown first, the account kind still
  the person's separate answer (ADR-0068's update).
- **Not demonstrated:** any live Splitwise, bank, balance, model, message or forwarding
  provider — none is connected, and each refuses by name when unconfigured; the declared statement
  layouts other than the generic and HDFC-style CSV/XLSX ones, through the browser; a PDF from any issuer other than the one
  synthetic IDFC FIRST layout (PDF reading is per-layout, never general); and optical reading of
  photographed documents, which stays an explicit opt-in (ADR-0051).
- **Owner decisions (6 Oct 2026):** ADR-0071 (a possible duplicate stays asked while either copy can
  still count, so one movement cannot be counted twice) and the ADR-0068 layout choice are
  **ratified as built**. Correcting the kind of an expense _already approved_ as personal, deferred
  from that release, is now **built**
  ([ADR-0073](docs/decisions/0073-an-expense-approved-as-personal-is-corrected-by-a-new-decision.md)):
  one audited decision, with a required reason, that makes it shared and saves who shared it
  together; the amount never changes.
- **Security: bounded evidence, not clearance.** An authenticated HawkScan DAST of a synthetic
  loopback target (21 described operations, including the new correction route, evidence reads and
  intake) found one Low, by-design item: the signed-in owner's own email, returned to them. Forty
  scripted probes found and fixed two more issues: a failed sign-in now answers 401, and an upload
  whose bytes are not its declared format is refused. Earlier rounds closed a cross-site write, a
  `Host` check ([ADR-0072](docs/decisions/0072-a-write-is-accepted-only-from-the-web-origin-this-ledger-serves.md))
  and unbounded XLSX inflation. Every production dependency advisory is closed. One development-only
  lint chain (`braces`) has no patched release and is unreachable in this configuration. Scope,
  exclusions and the real-ledger read-only acceptance:
  [`docs/testing/release-2026-10-06.md`](docs/testing/release-2026-10-06.md).
- **No background worker runs.** The job queue (`src/services/job-service.ts`) has a runner,
  but nothing starts it. No screen queues a job and no journey above needs one — imports and
  analysis run inside the request (ADR-0061) — but a job posted directly to `POST /api/jobs`
  would stay `queued`.

See [`docs/roadmap.md`](docs/roadmap.md) for the phase history and
[`docs/testing/process-isolation.md`](docs/testing/process-isolation.md) before starting,
stopping or seeding anything locally.

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
scripts/            Synthetic seeding and local-stack safety tools
src/
  domain/           Pure domain logic: entities, invariants, deterministic calculations
  services/         Application services orchestrating domain logic + persistence
  ai/               AI inference boundary — structured proposals only, never authoritative writes
  db/               Schema and persistence layer
  integrations/     Adapters to external systems (Splitwise, statement formats, document text, …)
  api/              Thin HTTP/API layer
tests/              Cross-cutting and integration tests
web/                The website: a standalone Next.js package that renders what the API computes
```

Each `src/` subdirectory has a `README.md` stating its responsibility and boundaries; `web/` has
its own (`web/README.md`, `web/Design.md`).

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
this on every push and pull request. The website is its own package and has the same gate under
`web/` (`npm --prefix web run typecheck | lint | format:check | test | build`).

Never run a synthetic seed, QA stack or teardown against the owner's real ledger: follow
[`docs/testing/process-isolation.md`](docs/testing/process-isolation.md).

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
