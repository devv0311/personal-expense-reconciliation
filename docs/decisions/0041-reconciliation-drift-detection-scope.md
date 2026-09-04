# 0041. Reconciliation drift detection: `fetchBalances`, comparison, and what marks a row `drifted`

**Status:** Accepted

## Context

`docs/roadmap.md` described phase 15 as: _"`ReconciliationRun` computation (now with
`ledger_investments_total` and `ledger_settlements_total` buckets, ADR-0011/0007) and discrepancy
surfacing, including `stale` vs `drifted` sync-status handling (ADR-0008)."_ Phases 12-14 each
found their own roadmap description stale in one direction or the other; this phase is the same
pattern again, checked directly against the code before writing this ADR:

- **Already built** (2026-08-14 foundation pass): `domain.computeUnexplained` with all five
  `ledger_*` buckets (outflow, transfers, investments, settlements, explained), and
  `services.runReconciliation` persisting a `ReconciliationRun` row with `insertReconciliationRun`
  and the `reconciliation_runs_unexplained_identity_check` row-level `CHECK`.
- **Not built at all**: `SplitwisePort.fetchBalances()` — the port's own docstring says so
  explicitly, deferring it here (`data-flow.md` step 9). `runReconciliation`'s `discrepancies`
  parameter is caller-supplied with no computation above it; nothing calls Splitwise, compares
  anything, or writes `splitwise_balances_snapshot`. `drifted` (`SPLITWISE_EXPENSE_SYNC_STATUSES`,
  `lifecycle.ts`'s `SPLITWISE_EXPENSE_SYNC_TRANSITIONS`) has no writer anywhere in the codebase —
  only `stale` does (`markSplitwiseExpenseStale`, wired into `distributeAdjustment` since phase
  12's foundation-pass code). No HTTP route exposes reconciliation at all (deferred explicitly by
  ADR-0038 and ADR-0039).
- There is no `db.listReconciliationRuns` — only `getLatestReconciliationRun`, which returns
  `discrepancies` alone (for `obligationEvidenceStatus`) and cannot serve a history view.

This ADR covers the drift-detection design specifically. Server/frontend architecture is ADR-0042.

## Decision

### 1. `SplitwisePort.fetchBalances()`

Added to the port, returning one entry per Splitwise friend of the connected account:

```ts
interface SplitwiseFriendBalance {
  readonly splitwiseUserId: string;
  /** Positive: the connected user owes this friend. Negative: the friend owes the user.
   *  Same sign convention as domain.computeNetBalance(user, friend). */
  readonly netBalance: Paise;
}
fetchBalances(): Promise<readonly SplitwiseFriendBalance[]>;
```

Scoped to **the connected user's own friends list**, matching what Splitwise's real API actually
exposes (a "get friends" call returns, per friend, their balance _with the authenticated account_
— not arbitrary third-party-to-third-party balances). This is also exactly what
`domain-model.md`'s own reconciliation text describes: _"Splitwise's own balance for the pair"_,
where in practice one side of "the pair" is always the connected account. No adapter ships with
this port change, matching ADR-0025/ADR-0040's precedent.

### 2. Comparison is a new pure domain function, not inline arithmetic in the service

`src/domain/splitwise-drift.ts` — `compareSplitwiseBalance(ours, theirs)` returns a
`ReconciliationDiscrepancy | null`: `null` when the two agree exactly, otherwise a
`kind: 'splitwise_balance_mismatch'` discrepancy carrying `personAId`/`personBId`/
`externalNetBalance`/`detail`. `ReconciliationDiscrepancy` already has every field this needs —
its own doc comment says it was left loosely typed _"until the reconciliation phase needs them
typed"_ (added in the 2026-08 revision, ahead of this phase). No new field was added to it.

Deterministic integer-`bigint` equality, no tolerance/threshold: this ledger's `NetBalance` and
Splitwise's reported balance are both exact minor-unit figures, so any non-zero difference is a
real, structural disagreement worth surfacing (`invariants.md` #12's "never a float" discipline
extends to comparison, not just computation).

### 3. `runReconciliation` calls it for every Splitwise-linked person, only when connected

`services.getBalance` already loads `BalanceInput` via `loadBalanceInput` and computes
`computeNetBalance` per pair on demand; `runReconciliation` now does the same walk once per run,
against every `Person` with a non-null `splitwise_user_id` (a new `db.listPersonsWithSplitwiseUserId`
query) other than the user. If no `ExternalIntegration` (`type = 'splitwise'`) is connected, this
whole step is skipped — `fetchBalances` is never called, `splitwiseBalancesSnapshot` stays `null`,
`discrepancies` stays `[]`, exactly today's behaviour. **This is required, not incidental**: the
app must run a full reconciliation with zero Splitwise setup, because `CLAUDE.md` forbids wiring
real Splitwise credentials during development, and the `runReconciliation` route is now
`web/`'s reconciliation dashboard's primary action.

`splitwiseBalancesSnapshot` stores the raw `fetchBalances()` result as-is (their reported figures,
verbatim) — the same "keep what they said, uninterpreted" pattern `SplitwiseExpense.their_snapshot`
already uses. `insertReconciliationRun` gains this as an additional optional field.

### 4. What marks a `SplitwiseExpense`/`SplitwiseSettlement` row `drifted`

A balance-level discrepancy is between the user and one friend — it does not, by itself, name
_which_ expense caused it (Splitwise's balance API is aggregate, not itemized). Two attribution
rules are used, both fully deterministic from data already in this ledger, so nothing here is a
guess dressed up as a fact:

- **Settlement rows**: unambiguous. A `synced` `SplitwiseSettlement` whose underlying `Settlement`
  has `counterparty_person_id = <the friend>` is between exactly this pair, so it is marked
  `drifted`.
- **Expense rows**: a `synced` `SplitwiseExpense` whose expense's `paid_by_person_id` is the user
  **and** whose _current_ allocation resolves the friend as a beneficiary (via
  `loaders.resolveAllocationShares` — reused, not re-implemented, per `invariants.md` #19) is
  marked `drifted`. An expense the friend paid is not reachable this way today because
  `SplitwiseExpense.paid_by_person_id` on the _Splitwise_ side always maps back to whoever this
  ledger recorded as payer — cross-payer attribution is out of scope here for the same reason it
  was out of scope for phase 14 (this system observes its own recorded payer, never infers one).

Every synced row touching the pair gets flagged — this can flag more than one row per discrepancy
when several expenses/settlements exist between the same two people, which is the correct,
conservative reading of _"surfaced, never auto-resolved by trusting either side blindly"_
(`domain-model.md`, `SplitwiseExpense` invariants): a human reviewing the pair sees everything that
might be implicated, not a single row this system guessed was the one responsible. Each transition
is `assertTransition`-checked against `SPLITWISE_EXPENSE_SYNC_TRANSITIONS`/
`_SETTLEMENT_TRANSITIONS` (already permit `synced → drifted`) and separately audited
(`entityType: 'splitwise_expense' | 'splitwise_settlement'`, same shape `markSplitwiseExpenseStale`'s
caller already uses for `stale`).

### 5. API surface

Three routes, mirroring the shape every other phase's read/write pair uses:

```
POST /api/reconciliation/runs        body: { periodStart, periodEnd, actor, reason? }
GET  /api/reconciliation/runs        ?limit=  — history, newest first
GET  /api/reconciliation/runs/:id    one run in full, including splitwiseBalancesSnapshot
```

`db.listReconciliationRuns`/`getReconciliationRunById` are new — `getLatestReconciliationRun`
stays as-is (it serves `obligationEvidenceStatus` specifically and returns less data on purpose).

## Deferred, explicitly

- **Re-syncing a `stale` `SplitwiseExpense`** (an amount update, or a deletion at net-zero
  `netAmount`, per `domain-model.md`'s "Splitwise implications of a net-zero adjustment"). This
  needs `updateExpense`/`deleteExpense` port methods, which is a real, separately-scoped _write_
  capability against Splitwise — categorically different from this phase's _read-and-compare_
  scope (`fetchBalances`, never a write). ADR-0040 already named this gap and explicitly did not
  assign it to phase 15; nothing in `data-flow.md` step 9 (the diagram this phase implements)
  mentions writing back to Splitwise either — only step 6a (adjustments) does, and only as a
  status flip this ledger already performs. Left for a future phase, and corrected in
  `roadmap.md`'s "Recommended next phase" note, which had read this as "phase 15's own call" —
  it is, and the call made here is to defer it, for the same reason ADR-0038/0039/0040 each
  declined an adjacent, differently-scoped capability rather than build it "since it's right
  there."
- **Resolving/dismissing a discrepancy** (`ReconciliationDiscrepancy.resolvedAt`). The field
  exists on the type already; writing to it is a distinct, later capability (a human confirming a
  drifted pair is now fine) that this phase's own scope — _detecting and surfacing_ drift — does
  not require. `invariants.md` #18 requires surfacing, not resolution.
- **Per-expense Splitwise refetch** (comparing `their_snapshot` against a fresh per-expense read).
  `fetchBalances()` is the only new port method `data-flow.md` step 9 names; adding a second,
  finer-grained read method is a bigger surface than this phase's own diagram calls for.

## Consequences

- `drifted` gets its first real writer, closing the gap phase 14 (ADR-0040) and the phase-14
  project memory both named explicitly.
- No financial arithmetic changes: `computeNetBalance`/`computeUnexplained` are reused exactly as
  they exist. The only new domain code is a pure equality comparison
  (`compareSplitwiseBalance`), which is as close to "no new domain logic" as a genuinely new
  capability can get.
- A period with no Splitwise integration connected reconciles exactly as it did before this
  phase — this is required for local development and for the UI's reconciliation dashboard to be
  usable with zero external setup.
- The attribution rule in §4 can flag more rows than the single one truly responsible for a given
  discrepancy. This is a real, named limitation (not silently accepted): a future phase with a
  per-expense Splitwise read could narrow it. Recorded here rather than discovered later.

## Alternatives considered

1. **Skip row-level `drifted` entirely; only ever write the aggregate discrepancy onto
   `ReconciliationRun`.** Rejected: `drifted` would then be a state nothing can ever reach, which
   makes `lifecycle.ts`'s `SPLITWISE_EXPENSE_SYNC_TRANSITIONS` describe a transition that can
   never fire — dead code describing a decision never made real, and the phase-14 memory
   explicitly flagged this as phase 15's job.
2. **Add a `fetchExpense(splitwiseExpenseId)` port method and attribute drift per-expense
   precisely**, instead of the pair-level heuristic in §4. Rejected as larger than this phase's
   own scope: `data-flow.md` step 9's diagram names exactly one new port call
   (`fetchBalances`), and a second read method is new surface nothing in this phase's own spec
   calls for — the same "don't build the adjacent capability because it's tempting" discipline
   ADR-0038/39/40 each applied.
3. **A numeric tolerance for "close enough" balances** (e.g. ignore a ₹1 gap from independent
   rounding). Rejected: both sides are exact integer minor units with no floating-point rounding
   anywhere in this ledger's own arithmetic (Largest Remainder Method, `invariants.md` #12), so a
   real disagreement is always exact; introducing a tolerance would hide a genuine, if small,
   inconsistency — exactly what invariant #20's "surfaced even when non-zero, especially when
   non-zero" argues against for the outflow total, and the same reasoning applies here.
