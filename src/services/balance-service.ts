/**
 * Balance and reconciliation reads.
 *
 * `Balance` is never written — it is recomputed from allocations and settlements on every
 * read (`data-flow.md`, step 7). There is no cache in front of it and no stored column
 * anywhere that could drift from the underlying rows.
 */

import {
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
  ReconciliationTotals,
} from '../domain/index.js';
import {
  getLatestReconciliationRun,
  insertReconciliationRun,
  listManualNoteExpenseIds,
  loadBalanceInput,
  loadReconciliationInput,
} from '../db/index.js';
import type { Database, Executor } from '../db/index.js';

import { runAudited, type AuditMeta } from './audit.js';

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

export interface GetBalanceOptions {
  /**
   * Expenses whose `manual_note` `Evidence` the caller has confirmed is a **claim that the
   * debt was cleared**, rather than documentation of the expense itself.
   *
   * Opt-in, and empty by default, because the schema cannot currently tell the two apart —
   * see {@link getBalance}. Passing ids here is an explicit human judgement, exactly as
   * ADR-0014 intends the signal to be.
   */
  readonly believedSettledExpenseIds?: readonly string[];
}

/**
 * Computes the pairwise balance between any two people, in either direction.
 *
 * Neither person needs to be the user: an obligation between two flatmates is fully
 * computable from allocation data alone, and stays correct even though its discharge may be
 * unobservable to this ledger (`invariants.md` #9b, `scenario-analysis.md` §34).
 *
 * @remarks
 * **The `manual_note` signal is not inferred automatically, deliberately.** ADR-0014 reads a
 * `manual_note` `Evidence` row linked to a contributing expense as "believed settled". But
 * ADR-0006 specifies the *same shape* — `type = manual_note`, `linked_expense_id` set — as
 * the only evidence an externally-funded expense ever has. With no field distinguishing the
 * two, auto-detecting the signal would mark every externally-funded expense's obligation
 * "believed settled" the moment it was recorded, which is precisely backwards.
 *
 * Rather than invent a schema field to break the tie, this service does not guess: the
 * signal is opt-in via {@link GetBalanceOptions.believedSettledExpenseIds}, and the
 * unambiguous Splitwise-discrepancy signal is wired as normal. `domain` still implements
 * ADR-0014 in full. Resolving the collision is a documentation decision, raised in the
 * Phase 1 report rather than settled here.
 */
export async function getBalance(
  db: Executor,
  userPersonId: PersonId,
  personAId: PersonId,
  personBId: PersonId,
  options: GetBalanceOptions = {},
): Promise<BalanceResult> {
  const input = await loadBalanceInput(db, userPersonId);
  const netBalance = computeNetBalance(input, personAId, personBId);

  const contributions = computeObligations(input).filter(
    (obligation) =>
      (obligation.debtorId === personAId && obligation.creditorId === personBId) ||
      (obligation.debtorId === personBId && obligation.creditorId === personAId),
  );

  const latestRun = await getLatestReconciliationRun(db);

  const evidenceStatus = obligationEvidenceStatus({
    netBalance,
    contributingExpenseIds: contributions.map((obligation) => obligation.expenseId),
    manualNoteExpenseIds: (options.believedSettledExpenseIds ?? []) as ExpenseId[],
    latestReconciliationRun:
      latestRun === null ? null : { discrepancies: toDiscrepancies(latestRun.discrepancies) },
    personAId,
    personBId,
  });

  return { personAId, personBId, netBalance, evidenceStatus, contributions };
}

/**
 * Every expense named by a `manual_note` `Evidence` row.
 *
 * Exposed so a review UI can *offer* these as candidate "believed settled" claims for a
 * human to confirm — never so a caller can feed them straight into {@link getBalance}
 * (see that function's remarks on why the shape is ambiguous).
 */
export async function listCandidateSettlementNotes(db: Executor): Promise<readonly ExpenseId[]> {
  return listManualNoteExpenseIds(db);
}

export interface RunReconciliationInput {
  readonly userPersonId: PersonId;
  readonly periodStart: Date;
  /** Exclusive, so consecutive periods neither overlap nor leave a gap. */
  readonly periodEnd: Date;
  readonly discrepancies?: readonly ReconciliationDiscrepancy[];
  readonly audit: AuditMeta;
}

export interface RunReconciliationResult {
  readonly reconciliationRunId: string;
  readonly totals: ReconciliationTotals;
}

/**
 * Computes and stores one reconciliation snapshot for a period.
 *
 * The arithmetic is `domain.computeUnexplained`; this function only gathers its inputs and
 * persists the result. `ledger_unexplained_total` is stored whatever it comes to — surfaced
 * especially when non-zero (`invariants.md` #20).
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

    const reconciliationRunId = await insertReconciliationRun(exec, {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      totals,
      discrepancies: input.discrepancies ?? [],
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
      },
    });

    return { reconciliationRunId, totals };
  });
}

/* ------------------------------------------------------------------------- internals */

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
