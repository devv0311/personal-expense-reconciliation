/**
 * Balance and reconciliation reads.
 *
 * `Balance` is never written — it is recomputed from allocations and settlements on every
 * read (`data-flow.md`, step 7). There is no cache in front of it and no stored column
 * anywhere that could drift from the underlying rows.
 */

import {
  NO_BOUNDARY_BALANCES,
  compareSplitwiseBalance,
  computeAccountCashSnapshot,
  computeNetBalance,
  computeObligations,
  computeUnexplained,
  netAmount,
  obligationEvidenceStatus,
  pairInternalTransfers,
  undistributedAmount,
  validateAccountCashSnapshot,
  validateInternalTransferNeutrality,
  validateReconciliationTotals,
} from '../domain/index.js';
import type {
  AccountBoundaryBalances,
  AccountCashSnapshotDraft,
  AccountId,
  CashMovement,
  ExpenseId,
  ObligationContribution,
  ObligationEvidenceStatus,
  Paise,
  PaymentId,
  PersonId,
  ReconciliationAccountSnapshot,
  ReconciliationDiscrepancy,
  ReconciliationRunId,
  ReconciliationTotals,
  ResolvedShare,
  SettlementId,
} from '../domain/index.js';
import {
  getConnectedExternalIntegration,
  getLatestReconciliationRun,
  getPrimaryUserPerson,
  getReconciliationRunById,
  insertReconciliationAccountSnapshot,
  insertReconciliationRun,
  listAccountsForCashReconciliation,
  listPersonsWithSplitwiseUserId,
  listReconciliationAccountSnapshots,
  listReconciliationRuns,
  listSettlementClaimExpenseIds,
  listSettlementRegister,
  listSyncedSplitwiseExpensesPaidBy,
  listSyncedSplitwiseSettlementsByCounterparty,
  loadBalanceInput,
  loadCashReconciliationInput,
  loadExpenseDistributionTotals,
  loadReconciliationInput,
  markSplitwiseExpenseDrifted,
  markSplitwiseSettlementDrifted,
} from '../db/index.js';
import type { Database, Executor, ReconciliationRunRow } from '../db/index.js';
import type { SplitwiseFriendBalance, SplitwisePort } from '../integrations/splitwise/index.js';

import { runAudited, type AuditContext, type AuditMeta } from './audit.js';
import { loadCurrentAllocation, resolveAllocationShares } from './loaders.js';
import { runSplitwiseAuditWithin } from './splitwise-audit-service.js';
import type { PrefetchedSplitwiseBalances } from './splitwise-audit-service.js';

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
  /**
   * The repayments already netted into `netBalance` (audit rows 7 and 30).
   *
   * Without these the page was arithmetically unexplainable: the audit found contributions of
   * ₹1,600 and ₹900 displayed under a ₹900 net, with the settlement that reconciles them
   * visible only in a proof pack. Gross obligations minus these settlements **is** the net,
   * and a screen quoting one figure should be able to show both halves of it.
   */
  readonly settlements: readonly BalanceSettlementLine[];
  /**
   * Expenses contributing to this pair whose refund has been recorded but not yet distributed
   * (audit row 25).
   *
   * A caveat, not a correction: `netBalance` is exactly what the current allocations say, and
   * these expenses have a reduction that no allocation reflects yet. Ignoring them would let a
   * screen present a figure as current when a pending distribution is about to move it.
   */
  readonly pendingRefundExpenseIds: readonly ExpenseId[];
}

/** One recorded repayment between the two people, as the balance read reports it. */
export interface BalanceSettlementLine {
  readonly settlementId: SettlementId;
  readonly paymentId: PaymentId;
  /** Who the payment moved *from*, derived from its direction and the ledger's own user. */
  readonly fromPersonId: PersonId;
  readonly toPersonId: PersonId;
  readonly amount: Paise;
  readonly occurredAt: Date;
  readonly reason: string | null;
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

  const [settlements, pendingRefundExpenseIds] = await Promise.all([
    loadPairSettlements(db, userPersonId, personAId, personBId),
    findPendingRefundExpenses(
      db,
      contributions.map((obligation) => obligation.expenseId),
    ),
  ]);

  return {
    personAId,
    personBId,
    netBalance,
    evidenceStatus,
    contributions,
    settlements,
    pendingRefundExpenseIds,
  };
}

/**
 * Which contributing expenses have a refund recorded that no allocation reflects yet.
 *
 * `domain.undistributedAmount` is the authority, exactly as it is for
 * `services.distributeAdjustment`: the database supplies three sums, and the domain decides
 * what they mean. An expense with no current allocation is skipped rather than reported —
 * it has no split to be out of date.
 */
async function findPendingRefundExpenses(
  db: Executor,
  expenseIds: readonly ExpenseId[],
): Promise<readonly ExpenseId[]> {
  const unique = [...new Set(expenseIds)];
  const totals = await loadExpenseDistributionTotals(db, unique);
  return totals
    .filter((row) => {
      if (!row.hasCurrentAllocation) return false;
      const net = netAmount(row.grossAmount, [row.adjustmentTotal]);
      // Signed since ADR-0052: a reversed refund leaves the allocation short rather than
      // ahead, and an out-of-date split is out of date in either direction.
      return undistributedAmount(row.currentLineTotal, net) !== 0n;
    })
    .map((row) => row.expenseId);
}

/**
 * The settlements between two people, in the shape a screen can subtract with.
 *
 * Direction comes from the payment, which is where it lives: a `Settlement` has no direction
 * column, deliberately — the payment says whether money left the user's account or arrived in
 * it (`schema.ts`, `settlements`). For a pair neither of whom is the user there is no payment
 * on either side, so there is nothing to list; that is `invariants.md` #9b, not a gap.
 */
async function loadPairSettlements(
  db: Executor,
  userPersonId: PersonId,
  personAId: PersonId,
  personBId: PersonId,
): Promise<readonly BalanceSettlementLine[]> {
  const counterparty =
    personAId === userPersonId ? personBId : personBId === userPersonId ? personAId : null;
  if (counterparty === null) return [];

  const rows = await listSettlementRegister(db, { counterpartyPersonId: counterparty });
  return rows.map((row) => ({
    settlementId: row.id,
    paymentId: row.paymentId,
    // A debit left the user's account, so the user paid the counterparty; a credit arrived.
    fromPersonId: row.direction === 'debit' ? userPersonId : counterparty,
    toPersonId: row.direction === 'debit' ? counterparty : userPersonId,
    amount: row.amount,
    occurredAt: row.occurredAt,
    reason: row.reason,
  }));
}

/**
 * One account's evidenced statement boundaries, as a human confirmed them.
 *
 * Supplied per run rather than read from a table, because nothing in the ledger ingests
 * statement *balances* yet — only movements. 17.5 requires each boundary to cite immutable
 * `Evidence`, so the citation travels with the figure and a run given neither produces
 * honestly `incomplete` snapshots rather than a cosmetic zero.
 */
export interface AccountBoundaryInput extends AccountBoundaryBalances {
  readonly accountId: AccountId;
}

export interface RunReconciliationInput {
  readonly userPersonId: PersonId;
  readonly periodStart: Date;
  /** Exclusive, so consecutive periods neither overlap nor leave a gap. */
  readonly periodEnd: Date;
  /** No concrete adapter is wired yet (ADR-0025/0040 precedent) — a caller injects one. */
  readonly splitwise: SplitwisePort;
  /**
   * Evidenced opening/closing balances, per account. Omit any account — or all of them — and
   * its snapshot is `incomplete`: unknown is not zero, and a closing balance is never derived
   * from the movements it exists to check (17.5).
   */
  readonly accountBoundaries?: readonly AccountBoundaryInput[];
  readonly audit: AuditMeta;
}

export interface RunReconciliationResult {
  readonly reconciliationRunId: string;
  readonly totals: ReconciliationTotals;
  readonly discrepancies: readonly ReconciliationDiscrepancy[];
  /** One per account, ADR-0017's second identity. Empty only when there are no accounts. */
  readonly accountSnapshots: readonly AccountCashSnapshotDraft[];
  /**
   * The phase 19 audit this run also produced (ADR-0046), or `null` when no Splitwise
   * integration is connected — in which case nothing external was read and the run behaves
   * exactly as it did before that phase, which `CLAUDE.md`'s "no real account in development"
   * rule requires.
   */
  readonly splitwiseAuditRunId: string | null;
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
 *
 * New in phase 16 (ADR-0017 (cash balance)): the same run also writes one immutable
 * `ReconciliationAccountSnapshot` per account, carrying the **second** identity —
 * `opening + credits - debits` against the statement's actual closing balance. The two are
 * computed independently and neither is derived from the other; ADR-0016's totals, fields and
 * callers are untouched (17.4). A run given no boundary evidence still writes snapshots, all
 * `incomplete` — which is the honest report, and the one thing a cosmetic zero would hide.
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

    const { discrepancies, splitwiseBalancesSnapshot, balances } = await detectSplitwiseDrift(
      exec,
      { userPersonId: input.userPersonId, splitwise: input.splitwise, record },
    );

    const reconciliationRunId = await insertReconciliationRun(exec, {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      totals,
      discrepancies: discrepancies.map(toStorableDiscrepancy),
      splitwiseBalancesSnapshot,
    });

    const accountSnapshots = await buildAccountCashSnapshots(exec, {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      boundaries: input.accountBoundaries ?? [],
    });
    for (const snapshot of accountSnapshots) {
      const snapshotId = await insertReconciliationAccountSnapshot(exec, {
        reconciliationRunId: reconciliationRunId,
        snapshot,
      });
      await record({
        entityType: 'reconciliation_account_snapshot',
        entityId: snapshotId,
        action: 'create',
        newValue: {
          accountId: snapshot.accountId,
          totalDebits: snapshot.totalDebits.toString(),
          totalCredits: snapshot.totalCredits.toString(),
          unexplainedDebits: snapshot.unexplainedDebits.toString(),
          unexplainedCredits: snapshot.unexplainedCredits.toString(),
          expectedEndingBalance: snapshot.expectedEndingBalance?.toString() ?? null,
          cashBalanceDelta: snapshot.cashBalanceDelta?.toString() ?? null,
          verificationStatus: snapshot.verificationStatus,
          discrepancyCount: String(snapshot.discrepancies.length),
        },
      });
    }

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
        accountSnapshotCount: accountSnapshots.length.toString(),
      },
    });

    // Phase 19's finer audit runs on the same balances this comparison already fetched, inside
    // the same transaction, so its findings can name the reconciliation they belong to. With no
    // integration connected it does not run at all — `balances` is null, nothing was read, and
    // there is nothing to audit (ADR-0046).
    const splitwiseAuditRunId =
      balances === null
        ? null
        : (
            await runSplitwiseAuditWithin(exec, record, {
              userPersonId: input.userPersonId,
              splitwise: input.splitwise,
              reconciliationRunId,
              prefetchedBalances: balances,
              audit: input.audit,
            })
          ).splitwiseAuditRunId;

    return { reconciliationRunId, totals, discrepancies, accountSnapshots, splitwiseAuditRunId };
  });
}

/** The account snapshots belonging to one run — ADR-0017's per-account cash report. */
export async function getReconciliationAccountSnapshots(
  db: Executor,
  reconciliationRunId: ReconciliationRunId,
): Promise<readonly ReconciliationAccountSnapshot[]> {
  return listReconciliationAccountSnapshots(db, reconciliationRunId);
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
  /**
   * What `fetchBalances()` produced, passed on to phase 19's audit so one run makes one
   * external read rather than asking Splitwise for the same figures twice (ADR-0046).
   * `null` when no integration is connected and nothing was called at all.
   */
  readonly balances: PrefetchedSplitwiseBalances | null;
}> {
  const ownerUser = await getPrimaryUserPerson(exec);
  const integration =
    ownerUser === null
      ? null
      : await getConnectedExternalIntegration(exec, ownerUser.userId, 'splitwise');
  if (integration === null) {
    // Reported rather than returned silently (audit finding 8). An empty discrepancy list
    // renders as "No discrepancies — the ledger matches", which for an unconnected
    // integration means "we did not look" being displayed as "we looked and agreed". The two
    // are the difference between a reconciled ledger and an unchecked one.
    return {
      discrepancies: [
        {
          kind: 'splitwise_not_connected',
          detail:
            'Splitwise was not checked: no integration is connected, so no comparison ran. ' +
            'This is not agreement — nothing was read.',
        },
      ],
      splitwiseBalancesSnapshot: null,
      balances: null,
    };
  }

  let theirBalances: readonly SplitwiseFriendBalance[];
  try {
    theirBalances = await input.splitwise.fetchBalances();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      discrepancies: [
        {
          kind: 'splitwise_fetch_failed',
          detail: 'fetchBalances() failed, so no drift comparison ran this time: ' + message,
        },
      ],
      splitwiseBalancesSnapshot: null,
      balances: { ok: false, error: message },
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

  return {
    discrepancies,
    splitwiseBalancesSnapshot,
    balances: { ok: true, balances: theirBalances },
  };
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

/**
 * Builds one account snapshot per account for a period (ADR-0017 (cash balance), 17.3–17.7).
 *
 * The order matters and is the whole of 17.3: transfer legs are paired across **every**
 * account first, because a leg's counter-leg lives on a different account and a per-account
 * pass cannot see it. Only then is each account computed independently, each carrying whatever
 * unpaired legs of its own the pairing left over — never a balancing leg invented to make the
 * period come out neutral.
 *
 * Every snapshot is re-checked through `domain.validateAccountCashSnapshot` before it is
 * written, so a report assembled by any path still cannot persist inconsistent arithmetic
 * (17.7). The database carries the same identities as row-local `CHECK`s; this layer is what
 * names the term that disagrees.
 */
async function buildAccountCashSnapshots(
  exec: Executor,
  input: {
    readonly periodStart: Date;
    readonly periodEnd: Date;
    readonly boundaries: readonly AccountBoundaryInput[];
  },
): Promise<readonly AccountCashSnapshotDraft[]> {
  const accounts = await listAccountsForCashReconciliation(exec);
  if (accounts.length === 0) return [];

  const movements = await loadCashReconciliationInput(exec, {
    start: input.periodStart,
    end: input.periodEnd,
  });
  const pairing = pairInternalTransfers(movements);
  const unpairedByAccount = groupUnpairedByAccount(movements, pairing.unpaired);
  const boundariesByAccount = new Map(
    input.boundaries.map((boundary) => [boundary.accountId, boundary]),
  );

  const snapshots: AccountCashSnapshotDraft[] = [];
  for (const account of accounts) {
    const snapshot = computeAccountCashSnapshot({
      accountId: account.id,
      currency: account.currency,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      movements: movements.filter((movement) => movement.accountId === account.id),
      boundaries: boundariesByAccount.get(account.id) ?? NO_BOUNDARY_BALANCES,
      unpairedTransferPaymentIds: unpairedByAccount.get(account.id) ?? [],
    });
    validateAccountCashSnapshot(snapshot);
    snapshots.push(snapshot);
  }

  // 17.3's consolidated check, asserted only over a fully paired scope: with an unpaired leg
  // in sight a non-zero net is *correct*, and asserting neutrality anyway would push callers
  // toward inventing the missing leg to satisfy it.
  validateInternalTransferNeutrality(snapshots, pairing);
  return snapshots;
}

function groupUnpairedByAccount(
  movements: readonly CashMovement[],
  unpaired: readonly PaymentId[],
): ReadonlyMap<AccountId, PaymentId[]> {
  const accountByPayment = new Map(
    movements.map((movement) => [movement.paymentId, movement.accountId]),
  );
  const grouped = new Map<AccountId, PaymentId[]>();
  for (const paymentId of unpaired) {
    const accountId = accountByPayment.get(paymentId);
    if (accountId === undefined) continue;
    const bucket = grouped.get(accountId) ?? [];
    bucket.push(paymentId);
    grouped.set(accountId, bucket);
  }
  return grouped;
}
