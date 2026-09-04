# Phase 15 — Reconciliation

## What already exists — confirmed before writing this spec

- `domain.computeUnexplained`/`validateReconciliationTotals` (`src/domain/reconciliation.ts`) —
  complete, all five `ledger_*` buckets, from the 2026-08-14 foundation pass.
- `services.runReconciliation`/`getBalance` (`src/services/balance-service.ts`) — complete for
  the ledger-internal half; `runReconciliation`'s `discrepancies` is a caller-supplied parameter
  with nothing computing it, and it never touches Splitwise.
- `db.insertReconciliationRun`/`getLatestReconciliationRun` — exist; no history listing, no
  single-run read, no `splitwiseBalancesSnapshot` write path.
- `SplitwisePort` (`createExpense`, `recordPayment`) — no `fetchBalances`.
- `lifecycle.ts`'s `SPLITWISE_EXPENSE_SYNC_TRANSITIONS`/`_SETTLEMENT_TRANSITIONS` already permit
  `synced → drifted → pending`; nothing calls the `drifted` transition.
- `db.markSplitwiseExpenseStale` — exists, wired into `distributeAdjustment` since the foundation
  pass; unaffected by this phase.
- `ReconciliationDiscrepancy` (`src/domain/entities.ts`) — already shaped for a pairwise balance
  disagreement (`personAId`/`personBId`/`externalNetBalance`/`kind`/`detail`/`resolvedAt`), its
  own comment deferring to "the reconciliation phase" for a use.
- `reconciliation_runs.splitwise_balances_snapshot` (jsonb, nullable) — column exists, unwritten.
- No `src/api` route for reconciliation at all (ADR-0038/0039 both deferred it here).
- **No live process serving the API at all.** `createApi().handle()` has never been called
  outside a test.

Full reasoning for both scope decisions below: ADR-0041 (drift detection), ADR-0042 (frontend
stack + server bridge).

## Scope decisions

1. **`SplitwisePort.fetchBalances()`** — new port method, one entry per friend
   (`splitwiseUserId`, `netBalance: Paise`, same sign convention as `computeNetBalance`). No
   adapter ships (ADR-0025/0040 precedent).
2. **`domain/splitwise-drift.ts`** — new, pure: `compareSplitwiseBalance(ours, theirs, ids)` →
   `ReconciliationDiscrepancy | null`. Exact `bigint` equality, no tolerance.
3. **`db` additions**: `listPersonsWithSplitwiseUserId`, `listSyncedSplitwiseExpensesPaidBy`,
   `listSyncedSplitwiseSettlementsByCounterparty`, `markSplitwiseExpenseDrifted`,
   `markSplitwiseSettlementDrifted`, `listReconciliationRuns`, `getReconciliationRunById`;
   `insertReconciliationRun` gains an optional `splitwiseBalancesSnapshot` field.
4. **`runReconciliation`** gains a required `splitwise: SplitwisePort` input. When no
   `ExternalIntegration` is connected, behaves exactly as today (no Splitwise call, empty
   discrepancies). When connected: computes `NetBalance(user, friend)` for every Splitwise-linked
   person, compares against `fetchBalances()`, records every discrepancy, and marks every
   `synced` `SplitwiseExpense`/`SplitwiseSettlement` touching a disagreeing pair `drifted`
   (attribution rule: ADR-0041 §4), each transition audited individually.
5. **Three routes**: `POST /api/reconciliation/runs`, `GET /api/reconciliation/runs`,
   `GET /api/reconciliation/runs/:id`.
6. **`src/server.ts`** — a `node:http` + Web `Request`/`Response` bridge over `createApi`, real
   `db`/`evidenceStore`, unconfigured `ai`/`splitwise` stubs defined privately inside it
   (ADR-0042).
7. **`web/`** — a standalone Next.js (App Router) + TypeScript + Tailwind + TanStack Query app,
   its own `package.json`, calling the server over `fetch`. Screens: reconciliation dashboard
   (run a period, see totals/discrepancies/Splitwise snapshot, history), balances explorer
   (pairwise `NetBalance` + `ObligationEvidenceStatus` + contributing obligations), expense
   ledger (filterable list). Loading/empty/error/success states throughout; responsive;
   keyboard/screen-reader accessible.

**Deferred, explicitly** (ADR-0041): re-syncing a `stale` `SplitwiseExpense`/`SplitwiseSettlement`
(needs `updateExpense`/`deleteExpense` port methods — a write capability, not this phase's
read-and-compare scope); resolving/dismissing a discrepancy (`resolvedAt` stays write-less);
per-expense Splitwise refetch for precise drift attribution; frontend coverage of review/evidence/
receipts (phases 9-11's own surfaces — out of this phase's product focus, "the actual
reconciliation product," per the brief); wiring `web/` into CI.

## The pipeline this phase adds

```
services.runReconciliation ─▶ domain.computeUnexplained (unchanged)
                            ─▶ db.listPersonsWithSplitwiseUserId
                            ─▶ (per friend) domain.computeNetBalance ─┐
                            ─▶ splitwise.fetchBalances ───────────────┼─▶ domain.compareSplitwiseBalance
                                                                       ▼
                                                          discrepancies[] + splitwiseBalancesSnapshot
                            ─▶ (per discrepancy) db.list*SyncedBy* ─▶ db.mark*Drifted (audited)
                            ─▶ db.insertReconciliationRun
```

```
browser ─▶ web/ (Next.js) ─▶ fetch http://localhost:4000/api/... ─▶ src/server.ts (node:http)
                                                                    ─▶ createApi(deps).handle(request)
                                                                    ─▶ (unchanged) src/api → src/services → src/db
```

## Testing plan

- `src/domain/splitwise-drift.test.ts` — pure unit tests: agreement, disagreement both
  directions, zero/zero.
- `tests/integration/reconciliation-service.test.ts` — real DB, mock `SplitwisePort`: no
  integration connected (unchanged behaviour); connected with agreeing balances (no
  discrepancy, no drift); a mismatch marks the right expense/settlement rows `drifted` and
  leaves unrelated ones `synced`; history listing/single-run read; the outflow-only totals
  identity still holds.
- `tests/integration/reconciliation-api.test.ts` — the three routes, success and error paths
  (`ENTITY_NOT_FOUND` for an unknown run id, validation errors for a malformed period).
- `tests/support/splitwise.ts` — `fetchBalances` added to the mock, scriptable per test.
- `web/` — component/integration tests for the three screens' loading/empty/error/success
  states (React Testing Library or equivalent — see implementation for the exact choice), plus
  a real browser check of the running app.

## What remains for Phase 16

Rules/learning (`docs/roadmap.md`). Also inherited, undecided by this phase on purpose (ADR-0041):
stale re-sync, discrepancy resolution, frontend coverage of review/evidence/receipts, and
frontend CI.
