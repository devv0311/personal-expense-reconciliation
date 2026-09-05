# 0015. General inflow/income reconciliation is explicitly out of scope for V1

> **Amendment (2026-09-05): partially superseded by
> [ADR-0017 (cash balance)](0017-pragmatic-cash-balance-reconciliation.md).** The outflow-only
> boundary below records the original implementation scope. Ordinary credits now participate
> in pragmatic bank cash reconciliation; general budgeting/tax logic remains outside the core.
> The new enum, lifecycle and account snapshot design govern Phase 16 onward.

**Status:** Partially superseded by ADR-0017 (cash balance), 2026-09-05

## Context

`ReconciliationRun` (and `invariants.md` #20's `ledger_unexplained_total` formula) has always
been scoped to outflow — `ledger_total_outflow` minus transfers, investments, settlements, and
explained expenses. Every prior revision noted this as "not yet modeled" or "an open question,"
without ever stating whether it was a deliberate V1 boundary or a gap waiting to be closed. Before
calling the domain model implementation-ready, this needs to be an explicit decision one way or
the other — and, per the task's own instruction, a check that nothing in the schema makes adding
it later impossible.

## Decision

**V1 reconciles outflow only** — outflows, expenses, obligations, settlements,
refunds/reimbursements, transfers, and investments, exactly the categories already named in
`invariants.md` #20's formula. **A general income/inflow accounting system — classifying and
reconciling ordinary credits that aren't a refund, a reimbursement, or a received settlement
(salary deposits, ad hoc payments received, interest, etc.) — is explicitly not built in V1.**
This is a scope decision made now, not a gap to be rediscovered.

**Confirmed the schema does not block adding it later.** `payments.direction` already supports
`credit`, and every credit that _is_ meaningful today (a refund, a reimbursement, a received
settlement) is already fully modeled via `ExpenseAdjustment.adjustment_payment_id` and
`Settlement.payment_id`. A plain, otherwise-unclassified credit simply isn't required to reach
`Payment.state = linked` — it can stay at `normalized` indefinitely, exactly mirroring how
`internal_account`/`investment_instrument` payments already behave (`lifecycle.md`). No table
needs restructuring to add income support later; a future phase would add new columns/tables (an
income-side classification, a `ledger_unexplained_inflow` total) rather than change anything that
exists today.

## Consequences

`domain-model.md`'s `ReconciliationRun` section gained an explicit "V1 scope, explicit" callout.
`lifecycle.md`'s Payment section gained an explicit bullet for plain-income credits. `roadmap.md`,
`database-design.md`'s "Deliberately deferred," `product/requirements.md`, and `product/
overview.md` all reworded from "open question" / "known gap" to "explicit V1 boundary, schema
doesn't block it later." No schema change in this ADR — it is a scope decision, not a design one;
the design of a future inflow phase is deliberately left unspecified until it's actually
scheduled.

## Alternatives considered

- **Build a minimal inflow classification now** (e.g. an `Income` entity or an
  `Expense`-symmetric concept for credits), even without full reconciliation. Rejected as
  premature: the task's own instruction was "do not implement a complete income/inflow accounting
  system yet," and a half-built classification with no reconciliation consumer would be
  speculative scope, not a coherent slice — against this project's stated "no speculative
  abstraction" convention (`CLAUDE.md`).
- **Leave it as an open question, as before.** Rejected — "open question" had been the status for
  multiple revisions without ever being resolved either way, which is itself a form of scope
  creep risk (an implementer could reasonably start building it without a decision ever having
  been made). Explicitly deciding "not in V1, and here's why the schema still allows it later" is
  strictly better than leaving the ambiguity in place.
