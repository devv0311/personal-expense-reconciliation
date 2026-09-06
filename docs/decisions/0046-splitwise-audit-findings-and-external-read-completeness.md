# 0046. Splitwise auditing: durable findings, earned attribution, and a read that knows what it missed

**Status:** Accepted

## Context

`docs/roadmap.md` describes phase 19 as: _"Extend Phase 15's completed pair-level comparison with
finer expense/allocation/refund and settlement evidence where the external read surface supports
it… Every finding must show compared snapshots, evidence, amount, suspected cause and confidence
or uncertainty. Aggregate mismatch alone must never assert a particular culprit."_

Checked directly against the code before writing this ADR:

- **Already built** (phase 15, [ADR-0041](0041-reconciliation-drift-detection-scope.md)):
  `SplitwisePort.fetchBalances()`, `domain.compareSplitwiseBalance`, the
  `splitwise_balance_mismatch` / `splitwise_fetch_failed` discrepancies on `ReconciliationRun`,
  and the pair-level rule that marks every touched `synced` row `drifted`. ADR-0041 §4 named the
  resulting imprecision as _"a real, named limitation"_ and said a per-expense read could narrow
  it. Phase 18 then made unreflected item refunds a real, common source of drift.
- **Not built at all**: any finer external read, any per-record attribution, any durable finding a
  person can review, and any resolution path. `ReconciliationDiscrepancy.resolvedAt` exists on the
  type and has no writer — ADR-0041 deferred it explicitly.

Two structural facts shaped everything below. First, `ReconciliationDiscrepancy` is a loose JSONB
entry inside `reconciliation_runs.discrepancies`: no identity, no history, no review state, and no
way for a rerun to recognise its own previous answer. Second, the only external read that exists is
aggregate — one net balance per friend — which cannot, even in principle, say _which_ record caused
a gap.

## Decision

### 1. `SplitwisePort.fetchLedgerEntries` is added, and is **optional**

```ts
fetchLedgerEntries?(input: { friendSplitwiseUserId: string }): Promise<{
  entries: readonly SplitwiseLedgerEntry[];
  complete: boolean;
  incompleteReason?: string;
}>;
```

Each entry carries Splitwise's own id, its kind (`expense` | `payment`), description, total, a
`deleted` flag, its date, and `pairNetBalance` — that entry's own signed contribution to the
balance between the connected account and the friend the read was scoped to, in the same
convention `fetchBalances` and `computeNetBalance` already use.

This is the smallest read that makes the roadmap's own list of causes observable at all. Without
entries, "missing external expense", "duplicate external expense", "duplicate settlement" and
"genuine amount disagreement" are not merely hard to attribute — they are indistinguishable from
each other and from every other cause, because the only signal is one number per friend. It is
still a **read**; nothing in phase 19 writes to Splitwise (§6).

**Optional, not required**, and that is the load-bearing half. An adapter that cannot list a pair's
entries omits the method, and the audit records the read as `unsupported`. The alternative — a
required method whose "I can't" answer is an empty array — makes a missing capability
indistinguishable from a Splitwise that holds nothing, which would manufacture a
`missing_external_expense` finding for every row this ledger ever synced. `src/server.ts`'s
unconfigured port omits it deliberately, and is the first example of the case.

`pairNetBalance` also gives the read a way to check itself: Splitwise's friends-list balance is the
sum of the pair's own entries, so a listing that claims to be `complete` and sums to something else
has not returned everything, whatever the adapter believed. `domain.assessExternalListingCompleteness`
downgrades that case to `partial` rather than reporting a ledger full of missing expenses.

### 2. Attribution is earned per record, and `balanceImpact` is what makes it checkable

`domain.auditSplitwisePair` is a new pure function beside `compareSplitwiseBalance`, which it
reuses rather than replaces. Every finding carries `balanceImpact`: the signed share of
`theirNetBalance − ourNetBalance` that finding claims to account for. The engine subtracts every
claim from the gap and reports the remainder as `unattributed_balance_mismatch` at `unknown`
confidence.

That single field is what stops attribution from being rhetorical. A finding set cannot quietly
over- or under-explain the disagreement it describes, because the residual is computed, not
asserted — and when nothing explains the gap, the honest answer is a first-class outcome rather
than an absence of findings. `unsupported_ghost_debt` exists at both `external_entry` scope (a
specific entry nothing local supports, `high`) and `pair` scope (the whole external figure is
unsupported, `low`, no culprit named), so "ghost debt" never implies a precision the read could not
provide.

`stale` and `drifted` stay distinct throughout, per `invariants.md` #18. A `stale` row produces a
finding whose named cause is the **local** adjustment — `stale_refund_partial`,
`stale_refund_full`, or `unreflected_item_refund` when `expense_adjustment_items` show the refund
landed on specific purchased items (ADR-0018/0045) — with the adjustment ids as evidence. A
disagreement about a record both sides still hold produces `external_amount_disagreement`. The two
are never merged, and a `stale` expense is never also reported as an amount disagreement, which
would double-count the same gap.

Net shares come from the **current** allocation, which phase 18 already made refund-aware. The
audit reads that figure; it does not recompute one. There is one allocation engine in this
codebase, and this is not it.

### 3. Findings are their own table, not a widened `ReconciliationDiscrepancy`

`splitwise_audit_runs` (provenance: which comparison ran, against how much of Splitwise it could
see) and `splitwise_audit_findings` (the findings themselves).

`ReconciliationDiscrepancy` was considered first, as the roadmap asks. It is insufficient in three
independent ways, not one: it is a JSONB array element with no id, so nothing can reference,
review or supersede a single entry; it has no review state, actor or reason, so a resolution has
nowhere to live; and it belongs to exactly one run, so a finding that persists across five runs
would be five unrelated copies with no way to tell them apart from five new problems. Its existing
role — the aggregate `splitwise_balance_mismatch` / `splitwise_fetch_failed` entries phase 15
writes — is **unchanged**, and `obligationEvidenceStatus` still reads it exactly as before.

A finding carries both compared snapshots (`local_snapshot`, `external_snapshot`), pointers to the
records that support it (`evidence`), the amount, the suspected cause (`kind`), its confidence, the
identifiers it actually knows, its run provenance, and its review state. `finding_class`
(`discrepancy` | `limitation` | `incomplete`) is a separate column from `kind` so a reader never
has to know all seventeen kinds to answer the first question worth asking: is this Splitwise being
wrong, or this system being honest about what it could not see?

Review history lives in `audit_events`, which is append-only by construction (`invariants.md` #22)
and already carries actor, time and reason. A dedicated review table would be a second place that
has to agree with the first — the same reasoning ADR-0031 used for duplicate dismissals.

### 4. Idempotency: identity is the cause, materiality is the comparison

Two columns carry the whole contract:

- **`fingerprint`** — `kind | scope | personA | personB | subject`, deliberately excluding every
  amount. A finding is "the same finding" when it is the same cause about the same record, even
  after the numbers move. A partial unique index on `fingerprint WHERE superseded_at IS NULL`
  enforces one current row per identity in the database, not by convention.
- **`comparison_digest`** — a SHA-256 over the canonical rendering of the compared snapshots and
  figures (`domain.findingComparisonSource`, with sorted keys and `bigint` as exact decimal text,
  so key order cannot change a digest).

Same digest: only `last_observed_at`/`last_observed_audit_run_id` are written, and **no audit event
at all** — recording "still true" on every run is precisely the audit noise the roadmap warns
against. Different digest: the standing row is superseded (`materially_changed`, naming its
replacement) and a new row is inserted. Nothing is ever edited in place, so the earlier row keeps
its evidence, its snapshots and the decision a person made about it.

A resolved finding still occupies its fingerprint, so an unchanged rerun re-observes it rather than
raising it again as new.

### 5. A finding is retired only by a run that could actually re-derive it

A standing finding this run did not reproduce is closed as `no_longer_observed` — but only when the
pair was audited **and**, for a finding that needed Splitwise's own entries
(`domain.findingDependsOnExternalRead`), that pair's read was `complete`. A `stale` refund finding
is re-derived from local evidence every time and can be retired on local evidence alone; a
`missing_external_expense` cannot.

This is the same rule as §1's, one layer up: a failed, partial or unsupported read is an
**incomplete check**, never agreement. Absence is evidence only under a complete read, so nothing
is reported as missing from a partial listing, and no finding is retired by a Splitwise that could
not be reached. A friend the balances call did not report at all is `external_record_inaccessible`,
and — because half a read is not a read — suppresses the absence-based conclusions for that pair
even when the entry listing itself returned cleanly.

`services.runReconciliation` keeps working with no Splitwise connected, unchanged: with no
integration the audit does not run at all, and with one connected it runs on the balances the
existing comparison already fetched, in the same transaction, so one run makes one external read.

### 6. Review records a conclusion; it authorizes nothing

`services.reviewSplitwiseAuditFinding` writes the finding's own review columns and one
`AuditEvent`, and touches nothing else — no `Payment`, `Expense`, `ExpenseItem`, `Allocation`,
`ExpenseAdjustment`, `Settlement`, obligation or balance, and no call to `SplitwisePort`. The
recorded `newValue` says `externalWriteAuthorized: false` in as many words.

`resolved` and `dismissed` require a reason; a decision nobody can reconstruct is not reviewable.
Only a person may decide (`actor` must be `user`/`user:<id>`, `invariants.md` #17) — not a rule,
not a model, not the system. A superseded finding cannot be reviewed: the record of what was
decided about it stays exactly as it was.

**Re-syncing a `stale` `SplitwiseExpense` remains unbuilt**, for the third ADR running (ADR-0040,
ADR-0041). It needs `updateExpense`/`deleteExpense` port methods — a write capability categorically
different from this phase's read-and-explain scope — and accepting an audit finding must not become
the thing that quietly authorizes one.

### 7. API surface

```
POST /api/splitwise/audits                     run one audit
GET  /api/splitwise/audits                     history, newest first
GET  /api/splitwise/audits/:id                 one run and the findings it produced
GET  /api/splitwise/audit-findings             findings, filtered
GET  /api/splitwise/audit-findings/:id         one finding, with its review history
POST /api/splitwise/audit-findings/:id/review  record a person's decision
```

Six routes, all read or decision. Superseded findings are excluded unless
`?includeSuperseded=true` asks for them — preserved, not hidden.

## Consequences

- Phase 15's aggregate comparison is extended, not replaced: `compareSplitwiseBalance`,
  `detectSplitwiseDrift`, the `drifted` marking rule and the existing `ReconciliationDiscrepancy`
  entries all behave exactly as before, and `detectSplitwiseDrift` now also hands its fetched
  balances to the audit so one reconciliation makes one `fetchBalances` call.
- A finding can name a specific expense, settlement or external entry — but only when the read
  supported it. Against an aggregate-only port the same disagreement is reported at pair scope with
  `unknown` confidence, which is a visible, testable difference in output rather than a silent
  degradation.
- The audit can flag more than the one record truly responsible when several plausibly match, and
  duplicate detection matches on shape (amount, description, date) rather than on an identifier,
  hence its `medium` confidence. Recorded here rather than discovered later, exactly as ADR-0041
  recorded its own attribution limit.
- Two pair-level limitations are now recorded as findings rather than left implicit:
  `non_user_settlement_unobservable` (the friends-list read cannot see a pair the user is not half
  of — `invariants.md` #9b's permanent boundary) and `cross_payer_attribution_unavailable` (only
  expenses the user paid have a synced row to attribute through, ADR-0041 §4).
- The migration is additive: two tables, plus `audit_events_entity_type_check` widened by two
  values. No column or table is dropped and no existing row is rewritten.

## Alternatives considered

1. **Widen `ReconciliationDiscrepancy` and store findings on the run.** Rejected for the three
   reasons in §3 — no identity, no review state, one run per finding. Reviewing "the third element
   of a JSONB array on run 12" is not a reviewable record, and a finding that outlives its run has
   nowhere to live.
2. **Require `fetchLedgerEntries` on the port.** Rejected: it makes "this adapter cannot list
   entries" indistinguishable from "Splitwise holds no entries", and the second reading turns a
   missing capability into a ledger full of fabricated missing-expense findings. The optional
   method is what lets the audit say `unsupported` and mean it.
3. **Infer the culprit from the aggregate gap by matching amounts** — find the expense whose share
   equals the difference and blame it. Rejected outright: it is exactly the "aggregate mismatch
   converted into a falsely precise culprit" the roadmap forbids, and it is most confident in
   precisely the cases where the evidence is thinnest (one candidate, therefore certain).
4. **Auto-resolve a finding that no longer reproduces.** Rejected in favour of superseding it as
   `no_longer_observed`: "resolved" is a person's conclusion with an actor and a reason, and
   silently attributing one to the system would put words in a reviewer's mouth. The distinction
   also keeps a failed read from ever reading as a resolution.
5. **Let a review trigger a corrective Splitwise write** ("resolve and re-sync"). Rejected for the
   reason §6 gives and ADR-0040/0041 each gave before: an outbound write is a separately scoped,
   separately approved capability, and the moment acceptance implies it, every review becomes a
   consequential external action.
6. **A tolerance for near-agreement.** Rejected again, for ADR-0041 §3's reason unchanged: both
   sides are exact integer minor units, so a one-paise disagreement is a real one-paise
   disagreement, and the test suite asserts it is reported.
