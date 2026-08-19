# 0021. Normalization acts only on `imported` payments, so a re-run is a no-op

**Status:** Accepted

## Context

Normalization writes DERIVED columns onto a payment: `channel`, `counterparty_type`,
`counterparty_id`, and the `state` transition itself. None of these are SOURCE values —
`invariants.md` #4's write-once guarantee covers `amount`, `occurred_at`, `raw_description`, and
`account_id`, and deliberately not these (ADR-0020's closing note). So nothing in the immutability
rules forbids writing them a second time.

That is precisely the problem. `normalizePayments` is a batch operation over "the payments that
need normalizing", and the obvious implementation of that phrase — every payment in the batch, or
every payment full stop — is re-runnable in the worst sense. A derived value that a person has
since acted on is still a decision: once a payment shows a resolved merchant in a review queue,
re-deriving it and quietly writing a different answer breaks CLAUDE.md's "approved financial
decisions do not silently change", even though no SOURCE column moved.

The general solution to that is versioning derived state — keep every derivation, mark one
current, let a re-run supersede rather than overwrite. `Allocation` already works this way
(ADR-0008's superseding allocations), because an allocation genuinely does get re-decided.

Normalization is not that. There is exactly one deterministic answer per payment given the row's
own evidence, and phase 7 exposes no way to ask for a different one: no re-derive endpoint, no
manual override, no rule change that would alter the mapping mid-flight.

## Decision

**Only payments at `state = 'imported'` are eligible.** `listPaymentsAwaitingNormalization`
filters on it, and that filter is the idempotency rule rather than a query optimisation.

Three things follow directly, and each is the point rather than a side effect:

1. **A second run is a no-op.** The first run moves every eligible payment to `normalized`; the
   second finds nothing eligible and writes nothing. Re-running the batch cannot rewrite a value,
   so "approved financial decisions do not silently change" holds without a version table for
   derived fields — the cheapest correct mechanism, not the most general one.
2. **`ignored` rows are excluded by the same filter.** A duplicate discarded at import
   (ADR-0019) sits at `ignored`, never at `imported`, so normalization cannot resurrect it. This
   needs no separate guard, which is why there isn't one.
3. **Re-deriving a normalization has no entry point in this phase, deliberately.** Not an
   oversight to be filled in later by relaxing the filter: a future re-derivation needs to decide
   what happens to a human decision made on top of the old value, and that is a design question
   with its own ADR, not a `where` clause.

## Consequences

**Eligibility must be read outside the transaction.** `runAudited` throws `AUDIT_EVENT_MISSING`
and rolls back when its body records zero audit events (`invariants.md` #21 — every mutation
writes an event, enforced structurally). A `normalizePayments` call with nothing to do would
therefore _throw_ rather than answer "there was nothing to normalize". So the service queries
eligibility first and returns an empty result without opening a transaction at all, mirroring how
`importBankStatementCsv` checks its content hash before entering `runAudited`.

The guard is exactly "no eligible payments", and nothing weaker would do. Every eligible payment
produces at least one event, because its `state` changes even when neither `channel` nor
`counterparty` does — so the empty-batch case is the only one that can reach the transaction with
nothing to record.

**Every normalized payment carries one `update` event, including the ones nothing refined.** The
event records `state`, `channel`, and `counterparty_type` on both sides, equal where unchanged.
An audit event says what happened, not only what differed; a reader asking "was this payment
normalized, and what did the rules conclude?" gets an answer either way.

**A payment normalized before a rule changes keeps its old answer.** If `refineChannel`'s mapping
is ever extended, already-`normalized` payments are not revisited. That is the correct default —
silently rewriting them is the exact failure this ADR exists to prevent — but it does mean a rule
change applies only to payments imported after it, and any backfill is a deliberate, separately
designed operation.

## Alternatives considered

- **Normalize every payment, every run, and let the writes be idempotent.** The mapping is
  deterministic, so re-deriving today's rows yields today's answers and nothing changes. Rejected
  because the guarantee is accidental: it holds only while no rule ever changes and no human ever
  edits a derived field, and both are expected to become false. It also rewrites every row on
  every run, so the audit log grows without recording anything that happened.
- **Version derived normalization state, superseding rather than overwriting.** The general
  answer, and the one `Allocation` uses. Rejected as speculative abstraction (CLAUDE.md): it costs
  a table and a "current" pointer to solve re-derivation, and phase 7 has no re-derivation. The
  state filter gets the same safety for one `where` clause, and versioning stays available if a
  later phase actually needs it.
- **Filter on `counterparty_type = 'unknown'` instead of on state.** Would re-offer any payment
  still unresolved, which sounds like a useful retry once the AI leg lands (ADR-0022). Rejected
  because it conflates "not yet normalized" with "normalized, and the answer was unknown" — the
  second is a recorded outcome, not a gap, and re-running it would overwrite the `channel`
  refinement that did succeed on the same row.
- **Let `normalizePayments` return empty by entering `runAudited` and recording a batch-level
  event.** Would remove the pre-transaction read. Rejected because it writes an audit event
  saying nothing happened, which pollutes the log the invariant exists to keep meaningful.
