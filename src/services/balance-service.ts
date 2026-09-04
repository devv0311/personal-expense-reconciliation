/**
 * Balance and reconciliation reads.
 *
 * `Balance` is never written — it is recomputed from allocations and settlements on every
 * read (`data-flow.md`, step 7). There is no cache in front of it and no stored column
 * anywhere that could drift from the underlying rows.
 */

import {
  compareSplitwiseBalance,
  computeNetBalance,
  computeObligations,
  computeUnexplained,
  obligationEvidenceStatus,
  validateReconciliationTotals,
} from '../domain/index.js';
import type {
  ExpenseId,
  ObligationContribution,
  ObligationEvidenceStatus,
  Paise,
  PersonId,
  ReconciliationDiscrepancy,
  ReconciliationRunId,
  ReconciliationTotals,
  ResolvedShare,
} from '../domain/index.js';
import {
  getConnectedExternalIntegration,
  getLatestReconciliationRun,
  getPrimaryUserPerson,
  getReconciliationRunById,
  insertReconciliationRun,
  listPersonsWithSplitwiseUserId,
  listReconciliationRuns,
  listSettlementClaimExpenseIds,
  listSyncedSplitwiseExpensesPaidBy,
  listSyncedSplitwiseSettlementsByCounterparty,
  loadBalanceInput,
  loadReconciliationInput,
  markSplitwiseExpenseDrifted,
  markSplitwiseSettlementDrifted,
} from '../db/index.js';
import type { Database, Executor, ReconciliationRunRow } from '../db/index.js';
import type { SplitwiseFriendBalance, SplitwisePort } from '../integrations/splitwise/index.js';

import { runAudited, type AuditContext, type AuditMeta } from './audit.js';
import { loadCurrentAllocation, resolveAllocationShares } from './loaders.js';

export interface BalanceResult {
  readonly personAId: PersonId;
  readonly personBId: PersonId;
  /** Positive means A owes B; negative means B owes A. */
  readonly netBalance: Paise;
  /**
   * Whether the ledger has evidence the debt was cleared.
   *
   * A read-only annotation. It never changes `netBalance`, and only a real `Settlement`
   * backed by a real `Payment` produces `settled_confirmed` (ADR-0014).
   */
  readonly evidenceStatus: ObligationEvidenceStatus;
  /** The individual obligations behind the figure, for explaining it. */
  readonly contributions: readonly ObligationContribution[];
}

/**
 * Computes the pairwise balance between any two people, in either direction.
 *
 * Neither person needs to be the user: an obligation between two flatmates is fully
 * computable from allocation data alone, and stays correct even though its discharge may be
 * unobservable to this ledger (`invariants.md` #9b, `scenario-analysis.md` §34).
 *
 * @remarks
 * Both of ADR-0014's signals are now read deterministically. The `manual_note` signal was
 * briefly opt-in, because ADR-0006 gives every externally-funded expense a manual note as its
 * only evidence and ADR-0014 read *any* manual note on a contributing expense as "believed
 * settled" — one shape, two opposite meanings, so inferring it marked those obligations
 * settled the moment they were recorded. `evidence.note_kind` (ADR-0018) distinguishes them,
 * so the service no longer has to choose between guessing and abstaining: it reads
 * `settlement_claim` notes and ignores documenting ones.
 */
export async function getBalance(
  db: Executor,
  userPersonId: PersonId,
  personAId: PersonId,
  personBId: PersonId,
): Promise<BalanceResult> {
  const input = await loadBalanceInput(db, userPersonId);
  const netBalance = computeNetBalance(input, personAId, personBId);

  const contributions = computeObligations(input).filter(
    (obligation) =>
      (obligation.debtorId === personAId && obligation.creditorId === personBId) ||
      (obligation.debtorId === personBId && obligation.creditorId === personAId),
  );

  const latestRun = await getLatestReconciliationRun(db);
  const settlementClaimExpenseIds = await listSettlementClaimExpenseIds(db);

  const evidenceStatus = obligationEvidenceStatus({
    netBalance,
    contributingExpenseIds: contributions.map((obligation) => obligation.expenseId),
    settlementClaimExpenseIds,
    latestReconciliationRun:
      latestRun === null ? null : { discrepancies: toDiscrepancies(latestRun.discrepancies) },
    personAId,
    personBId,
  });

  return { personAId, personBId, netBalance, evidenceStatus, contributions };
}

export interface RunReconciliationInput {
  readonly userPersonId: PersonId;
  readonly periodStart: Date;
  /** Exclusive, so consecutive periods neither overlap nor leave a gap. */
  readonly periodEnd: Date;
  /** No concrete adapter is wired yet (ADR-0025/0040 precedent) — a caller injects one. */
  readonly splitwise: SplitwisePort;
  readonly audit: AuditMeta;
}

export interface RunReconciliationResult {
  readonly reconciliationRunId: string;
  readonly totals: ReconciliationTotals;
  readonly discrepancies: readonly ReconciliationDiscrepancy[];
}

/**
 * Computes and stores one reconciliation snapshot for a period.
 *
 * The outflow arithmetic is `domain.computeUnexplained`, unchanged since before this phase.
 * New in phase 15 (ADR-0041): when a Splitwise `ExternalIntegration` is connected, this also
 * compares this ledger's own `NetBalance` against `splitwise.fetchBalances()` for every
 * Splitwise-linked person, records any disagreement as a `ReconciliationDiscrepancy`, and marks
 * every affected `synced` `SplitwiseExpense`/`SplitwiseSettlement` `drifted`. With no integration
 * connected, `splitwise.fetchBalances()` is never called and this behaves exactly as before —
 * required, since `CLAUDE.md` forbids a real Splitwise connection in development.
 * `ledger_unexplained_total` is stored whatever it comes to — surfaced especially when non-zero
 * (`invariants.md` #20).
 */
export async function runReconciliation(
  db: Database,
  input: RunReconciliationInput,
): Promise<RunReconciliationResult> {
  return runAudited(db, input.audit, async ({ exec, record }) => {
    const raw = await loadReconciliationInput(
      exec,
      { start: input.periodStart, end: input.periodEnd },
      input.userPersonId,
    );

    const totals = computeUnexplained({
      payments: raw.payments.map((payment) => ({
        direction: payment.direction,
        amount: payment.amount,
        counterpartyType: payment.counterpartyType as Parameters<
          typeof computeUnexplained
        >[0]['payments'][number]['counterpartyType'],
        state: payment.state as Parameters<
          typeof computeUnexplained
        >[0]['payments'][number]['state'],
      })),
      settlements: raw.settlements,
      expenses: raw.expenses,
    });
    validateReconciliationTotals(totals);

    const { discrepancies, splitwiseBalancesSnapshot } = await detectSplitwiseDrift(exec, {
      userPersonId: input.userPersonId,
      splitwise: input.splitwise,
      record,
    });

    const reconciliationRunId = await insertReconciliationRun(exec, {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      totals,
      discrepancies: discrepancies.map(toStorableDiscrepancy),
      splitwiseBalancesSnapshot,
    });

    await record({
      entityType: 'reconciliation_run',
      entityId: reconciliationRunId,
      action: 'create',
      newValue: {
        periodStart: input.periodStart.toISOString(),
        periodEnd: input.periodEnd.toISOString(),
        ledgerTotalOutflow: totals.ledgerTotalOutflow.toString(),
        ledgerTransfersTotal: totals.ledgerTransfersTotal.toString(),
        ledgerInvestmentsTotal: totals.ledgerInvestmentsTotal.toString(),
        ledgerSettlementsTotal: totals.ledgerSettlementsTotal.toString(),
        ledgerExplainedTotal: totals.ledgerExplainedTotal.toString(),
        ledgerUnexplainedTotal: totals.ledgerUnexplainedTotal.toString(),
        discrepancyCount: discrepancies.length.toString(),
      },
    });

    return { reconciliationRunId, totals, discrepancies };
  });
}

/** History, newest first — a reconciliation dashboard's run list. */
export async function listReconciliationRunHistory(
  db: Executor,
  options: { readonly limit?: number } = {},
): Promise<readonly ReconciliationRunRow[]> {
  return listReconciliationRuns(db, options);
}

/** One `ReconciliationRun` in full, or `null` when the id does not exist. */
export async function getReconciliationRun(
  db: Executor,
  reconciliationRunId: ReconciliationRunId,
): Promise<ReconciliationRunRow | null> {
  return getReconciliationRunById(db, reconciliationRunId);
}

/* ------------------------------------------------------------------------- internals */

/**
 * Compares this ledger's `NetBalance` against Splitwise's reported balance for every
 * Splitwise-linked person, and marks every affected synced row `drifted` (ADR-0041).
 *
 * Returns `{ discrepancies: [], splitwiseBalancesSnapshot: null }` with no Splitwise call made
 * at all when no `ExternalIntegration` is connected — reconciliation must fully work with zero
 * Splitwise setup.
 *
 * A `fetchBalances()` failure (the account is connected, but the call itself errors — a network
 * failure, an unconfigured adapter) does **not** fail the whole run: this ledger's own outflow
 * totals are independent of Splitwise and must still be computed and stored. The failure is
 * surfaced as one `splitwise_fetch_failed` discrepancy instead of being silently swallowed —
 * "surfaced, never hidden" applies to a failed check exactly as it does to a disagreeing one.
 */
async function detectSplitwiseDrift(
  exec: Executor,
  input: {
    readonly userPersonId: PersonId;
    readonly splitwise: SplitwisePort;
    readonly record: AuditContext['record'];
  },
): Promise<{
  readonly discrepancies: ReconciliationDiscrepancy[];
  readonly splitwiseBalancesSnapshot: unknown;
}> {
  const ownerUser = await getPrimaryUserPerson(exec);
  const integration =
    ownerUser === null
      ? null
      : await getConnectedExternalIntegration(exec, ownerUser.userId, 'splitwise');
  if (integration === null) {
    return { discrepancies: [], splitwiseBalancesSnapshot: null };
  }

  let theirBalances: readonly SplitwiseFriendBalance[];
  try {
    theirBalances = await input.splitwise.fetchBalances();
  } catch (error) {
    return {
      discrepancies: [
        {
          kind: 'splitwise_fetch_failed',
          detail:
            'fetchBalances() failed, so no drift comparison ran this time: ' +
            (error instanceof Error ? error.message : String(error)),
        },
      ],
      splitwiseBalancesSnapshot: null,
    };
  }

  const [friends, balanceInput, syncedExpenses] = await Promise.all([
    listPersonsWithSplitwiseUserId(exec, input.userPersonId),
    loadBalanceInput(exec, input.userPersonId),
    listSyncedSplitwiseExpensesPaidBy(exec, input.userPersonId),
  ]);

  const sharesByExpenseId = new Map<ExpenseId, readonly ResolvedShare[]>();
  for (const row of syncedExpenses) {
    const current = await loadCurrentAllocation(exec, row.expenseId);
    sharesByExpenseId.set(row.expenseId, current === null ? [] : resolveAllocationShares(current));
  }

  // A friend Splitwise does not report at all (never in this response, as opposed to reporting
  // a balance of 0) is treated as "nothing to compare" rather than "Splitwise says 0" — this
  // ledger having linked a `splitwise_user_id` locally does not guarantee Splitwise's own
  // friends list currently includes them.
  const theirBalanceByUserId = new Map(
    theirBalances.map((entry) => [entry.splitwiseUserId, entry.netBalance]),
  );
  const discrepancies: ReconciliationDiscrepancy[] = [];

  for (const friend of friends) {
    const theirs = theirBalanceByUserId.get(friend.splitwiseUserId);
    if (theirs === undefined) continue;

    const ours = computeNetBalance(balanceInput, input.userPersonId, friend.id);
    const discrepancy = compareSplitwiseBalance({
      ourNetBalance: ours,
      theirNetBalance: theirs,
      userPersonId: input.userPersonId,
      friendPersonId: friend.id,
    });
    if (discrepancy === null) continue;
    discrepancies.push(discrepancy);

    for (const row of syncedExpenses) {
      const shares = sharesByExpenseId.get(row.expenseId) ?? [];
      if (!shares.some((share) => share.beneficiaryId === friend.id)) continue;
      const moved = await markSplitwiseExpenseDrifted(exec, row.id);
      if (moved) {
        await input.record({
          entityType: 'splitwise_expense',
          entityId: row.id,
          action: 'update',
          oldValue: { syncStatus: 'synced' },
          newValue: { syncStatus: 'drifted', theirNetBalance: theirs.toString() },
        });
      }
    }

    const syncedSettlements = await listSyncedSplitwiseSettlementsByCounterparty(exec, friend.id);
    for (const row of syncedSettlements) {
      const moved = await markSplitwiseSettlementDrifted(exec, row.id);
      if (moved) {
        await input.record({
          entityType: 'splitwise_settlement',
          entityId: row.id,
          action: 'update',
          oldValue: { syncStatus: 'synced' },
          newValue: { syncStatus: 'drifted', theirNetBalance: theirs.toString() },
        });
      }
    }
  }

  const splitwiseBalancesSnapshot = theirBalances.map((entry) => ({
    splitwiseUserId: entry.splitwiseUserId,
    netBalance: entry.netBalance.toString(),
  }));

  return { discrepancies, splitwiseBalancesSnapshot };
}

/**
 * The write side of {@link toDiscrepancies} below: JSONB cannot serialize a `bigint`
 * (invariants.md #12's discipline applies at this boundary too), so `externalNetBalance`
 * crosses as an exact decimal string, the same convention every other money field crossing an
 * API/storage boundary in this codebase already uses.
 */
function toStorableDiscrepancy(discrepancy: ReconciliationDiscrepancy): Record<string, unknown> {
  const { externalNetBalance, ...rest } = discrepancy;
  return {
    ...rest,
    ...(externalNetBalance === undefined
      ? {}
      : { externalNetBalance: externalNetBalance.toString() }),
  };
}

/** Revives `bigint` amounts from the JSONB discrepancy list, which stores them as text. */
function toDiscrepancies(raw: unknown): ReconciliationDiscrepancy[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): ReconciliationDiscrepancy[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const external = record.externalNetBalance;
    return [
      {
        kind: typeof record.kind === 'string' ? record.kind : 'unknown',
        detail: typeof record.detail === 'string' ? record.detail : '',
        ...(typeof record.personAId === 'string'
          ? { personAId: record.personAId as PersonId }
          : {}),
        ...(typeof record.personBId === 'string'
          ? { personBId: record.personBId as PersonId }
          : {}),
        ...(typeof external === 'string' || typeof external === 'number'
          ? { externalNetBalance: BigInt(external) as Paise }
          : {}),
      },
    ];
  });
}
