/**
 * The end results, in one read — what a person opening this actually came to find out.
 *
 * Every other service here answers a question about the machinery: what a payment is explained
 * by, which evidence matches which movement, what a reconciliation run concluded. Those are the
 * right questions for the person maintaining the ledger and the wrong ones for the person who
 * owns the money, whose four questions are: what did I spend, what does the ledger still not
 * understand, what needs me, and who owes whom.
 *
 * **This composes; it does not compute.** Spending comes from `getCategorySpend`, balances from
 * `getOutstandingBalances`, the decision queue from `listReviewQueue`. Exactly one figure is
 * genuinely new — the ledger-wide unexplained total — and it is built by running the *same*
 * `domain.explainedAmount` the payment workspace runs, row by row, rather than by writing a
 * second definition of "explained" in SQL. One definition, two callers.
 *
 * **A figure the ledger cannot stand behind comes back `known: false`.** It never comes back as
 * zero. `web/CLAUDE.md`'s second rule is that a verified zero over incomplete evidence is the
 * one number this product must never print, and a summary screen is where that temptation is
 * strongest: a dashboard reading ₹0 unexplained is indistinguishable from a dashboard that has
 * not finished looking. The flag is what lets a screen say "Needs review" honestly.
 */

import { explainedAmount, isDuplicateRepresentation } from '../domain/index.js';
import type { Paise, PersonId } from '../domain/index.js';
import { listPaymentsForWorkspace } from '../db/index.js';
import type { Executor } from '../db/index.js';

import { getAnalysisReadiness } from './analysis-service.js';
import type { AnalysisReadiness } from './analysis-service.js';
import { getCategorySpend, getOutstandingBalances } from './analytics-service.js';
import { listAttentionQuestions } from './attention-service.js';
import type {
  AnalyticsCaveats,
  AnalyticsPeriod,
  CounterpartyBalance,
} from './analytics-service.js';
/**
 * A figure, and whether the ledger can stand behind it.
 *
 * `known: false` means "not enough evidence to say", and the caller must render that as words
 * rather than as a number. The amount is still carried when one exists, because "we read this
 * much so far" is sometimes worth showing *beside* the caveat — but never instead of it.
 */
export interface OverviewFigure {
  readonly known: boolean;
  /** Exact paise. `null` when nothing could be computed at all. */
  readonly amount: Paise | null;
  /** Why the figure is not known, when it is not. Never a technical state name. */
  readonly unknownReason?: string;
}

/** How much of the ledger the unexplained sweep actually looked at. */
export interface UnexplainedSummary {
  readonly total: OverviewFigure;
  /** Movements carrying some unexplained amount. */
  readonly movementCount: number;
  /** Movements examined. Below `scanned` the total is a floor, not a total. */
  readonly scanned: number;
  readonly complete: boolean;
  /**
   * The newest few movements the total is made of.
   *
   * Carried so a screen can name what is unaccounted for and link to the event rather than
   * printing a figure and leaving the reader to go and find it in a payment workspace. A
   * sample, not the set: `movementCount` says how many there are.
   */
  readonly movements: readonly OverviewActivity[];
}

export interface OverviewAttention {
  /**
   * Everything waiting on a human decision — the same number **Needs attention** shows.
   *
   * Taken from `listAttentionQuestions`, not from the review queue alone, because the front
   * page and the screen it points at disagreeing about how much is waiting is worse than
   * either number being slightly larger: it makes both untrustworthy.
   */
  readonly total: number;
  /** The review queue's own total, which is the subset `/api/review` reports. */
  readonly reviewQueueTotal: number;
  /** Per review kind, for a screen that wants to lead with the biggest group. */
  readonly counts: Readonly<Record<string, number>>;
}

export interface OverviewPeople {
  readonly toCollect: OverviewFigure;
  readonly toPay: OverviewFigure;
  /** Largest balances first, both directions, so a screen can show the few that matter. */
  readonly counterparties: readonly CounterpartyBalance[];
  /**
   * People shared with whose balance is now exactly zero.
   *
   * Carried so a screen can say "you are square with Alex" rather than leaving Alex off it
   * entirely, which is indistinguishable from never having shared anything with them.
   */
  readonly settled: readonly CounterpartyBalance[];
}

export interface OverviewSpending {
  readonly period: AnalyticsPeriod;
  readonly total: OverviewFigure;
  readonly categories: readonly {
    readonly category: string | null;
    readonly netTotal: Paise;
    readonly expenseCount: number;
  }[];
  readonly caveats: AnalyticsCaveats;
}

/** One recent movement, in the plainest terms a screen can show it. */
export interface OverviewActivity {
  readonly paymentId: string;
  readonly occurredAt: Date;
  readonly description: string;
  readonly amount: Paise;
  readonly direction: 'debit' | 'credit';
  /** `understood` when nothing about it is outstanding; `needs_context` when money is unaccounted. */
  readonly status: 'understood' | 'needs_context';
}

export interface OverviewResult {
  readonly spending: OverviewSpending;
  /**
   * What is on file and has not been looked at yet.
   *
   * The difference between "nothing was spent" and "nothing has been read yet" is invisible in
   * a total and is not the same statement at all. This is what lets the front page offer the
   * analysis when there is something to analyse, and say so rather than printing a confident
   * zero over a statement it has imported and not understood.
   */
  readonly readiness: AnalysisReadiness;
  readonly unexplained: UnexplainedSummary;
  readonly attention: OverviewAttention;
  readonly people: OverviewPeople;
  readonly recent: readonly OverviewActivity[];
  /** True when the ledger holds nothing at all, so a screen can invite a first record. */
  readonly empty: boolean;
}

export interface OverviewInput {
  readonly userPersonId: PersonId;
  readonly period: AnalyticsPeriod;
  /**
   * How many movements the unexplained sweep may examine.
   *
   * A bound rather than an unbounded scan, because this read sits on the front page and runs on
   * every visit. When the ledger is larger than the bound the result says so (`complete: false`)
   * and the total is reported as a floor — an honest "at least this much" beats either a slow
   * page or a confident wrong number.
   */
  readonly unexplainedScanLimit?: number;
}

/** Orders two signed balances by size, ignoring which way the debt runs. */
function compareMagnitude(left: Paise, right: Paise): number {
  const leftSize = left < 0n ? 0n - left : left;
  const rightSize = right < 0n ? 0n - right : right;
  return leftSize > rightSize ? 1 : leftSize < rightSize ? -1 : 0;
}

const DEFAULT_SCAN_LIMIT = 2000;
const RECENT_LIMIT = 8;
const UNEXPLAINED_SAMPLE_LIMIT = 8;

export async function getOverview(db: Executor, input: OverviewInput): Promise<OverviewResult> {
  const scanLimit = input.unexplainedScanLimit ?? DEFAULT_SCAN_LIMIT;

  const [spending, outstanding, queue, readiness, rows] = await Promise.all([
    getCategorySpend(db, input.period),
    getOutstandingBalances(db, input.userPersonId),
    listAttentionQuestions(db, { limit: 1 }),
    getAnalysisReadiness(db),
    // One extra row, so "is there more than the bound?" is answered by the read rather than
    // guessed from whether the page came back full.
    listPaymentsForWorkspace(db, { limit: scanLimit + 1 }),
  ]);

  const complete = rows.length <= scanLimit;
  const scannedRows = complete ? rows : rows.slice(0, scanLimit);

  let unexplainedTotal = 0n;
  let unexplainedMovements = 0;
  const unexplainedSample: OverviewActivity[] = [];
  for (const row of scannedRows) {
    // The same domain call the payment workspace makes. A second definition of "explained"
    // written here would be a second thing to keep true.
    if (isDuplicateRepresentation({ state: row.state, ignoredReason: row.ignoredReason })) continue;
    const explained = explainedAmount({
      paymentId: row.id,
      accountId: row.accountId,
      direction: row.direction,
      amount: row.amount,
      currency: row.currency,
      counterpartyType: row.counterpartyType,
      cashFlowCategory: row.cashFlowCategory,
      cashFlowState: row.cashFlowState,
      state: row.state,
      ignoredReason: row.ignoredReason,
      externalReference: row.externalReference,
      explanation: {
        expenseLinkTotal: row.expenseLinkTotal,
        settlementTotal: row.settlementTotal,
        adjustmentTotal: row.adjustmentTotal,
      },
    });
    const gap = row.amount - explained;
    if (gap > 0n) {
      unexplainedTotal += gap;
      unexplainedMovements += 1;
      if (unexplainedSample.length < UNEXPLAINED_SAMPLE_LIMIT) {
        unexplainedSample.push({
          paymentId: row.id,
          occurredAt: row.occurredAt,
          description: row.rawDescription,
          amount: row.amount,
          direction: row.direction,
          status: 'needs_context',
        });
      }
    }
  }

  const recent = scannedRows.slice(0, RECENT_LIMIT).map((row) => {
    const duplicate = isDuplicateRepresentation({
      state: row.state,
      ignoredReason: row.ignoredReason,
    });
    const explained = duplicate
      ? row.amount
      : explainedAmount({
          paymentId: row.id,
          accountId: row.accountId,
          direction: row.direction,
          amount: row.amount,
          currency: row.currency,
          counterpartyType: row.counterpartyType,
          cashFlowCategory: row.cashFlowCategory,
          cashFlowState: row.cashFlowState,
          state: row.state,
          ignoredReason: row.ignoredReason,
          externalReference: row.externalReference,
          explanation: {
            expenseLinkTotal: row.expenseLinkTotal,
            settlementTotal: row.settlementTotal,
            adjustmentTotal: row.adjustmentTotal,
          },
        });
    return {
      paymentId: row.id,
      occurredAt: row.occurredAt,
      description: row.rawDescription,
      amount: row.amount,
      direction: row.direction,
      status: row.amount - explained > 0n ? ('needs_context' as const) : ('understood' as const),
    };
  });

  return {
    readiness,
    spending: {
      period: input.period,
      // A period total is knowable whenever the period is: an empty period legitimately spent
      // nothing, which is not the same uncertainty an unscanned ledger has.
      total: { known: true, amount: spending.netTotal },
      categories: spending.categories.map((entry) => ({
        category: entry.category,
        netTotal: entry.netTotal,
        expenseCount: entry.expenseCount,
      })),
      caveats: spending.caveats,
    },
    unexplained: {
      total: complete
        ? { known: true, amount: unexplainedTotal as Paise }
        : {
            known: false,
            amount: unexplainedTotal as Paise,
            unknownReason:
              'There are more movements on record than this summary reads in one pass, so this ' +
              'is at least the amount still unaccounted for rather than all of it.',
          },
      movementCount: unexplainedMovements,
      scanned: scannedRows.length,
      complete,
      movements: unexplainedSample,
    },
    attention: {
      total: queue.total,
      reviewQueueTotal: queue.reviewQueueTotal,
      counts: queue.counts,
    },
    people: {
      toCollect: { known: true, amount: outstanding.totalOwedToUser },
      toPay: { known: true, amount: outstanding.totalOwedByUser },
      counterparties: [...outstanding.counterparties].sort((left, right) =>
        compareMagnitude(right.netBalance, left.netBalance),
      ),
      settled: outstanding.settled,
    },
    recent,
    empty: rows.length === 0,
  };
}
