/**
 * What you spent — everything the Spending screen shows, in one read.
 *
 * ```
 * services.getSpendingSummary ─▶ services.getCategorySpend   where it went
 *                             ─▶ services.getMonthlySpend    month by month
 *                             ─▶ services.getOwnSpend        your own share of it
 *                             ─▶ services.getOverview        what nothing accounts for
 * ```
 *
 * Composition, not computation: every figure below is one an existing read produced, and none
 * of them is re-derived here. One call rather than four because these figures have to agree
 * with each other — a category total and an own-share taken milliseconds apart over a changing
 * ledger can disagree, and a screen showing both would have no way to know.
 *
 * It exists because `/spending` was sending anybody who wanted a trend to `/analytics`, which
 * is the screen named after the machinery. The trend, the own share and what came back are all
 * ordinary questions; only the caveat list and the raw period controls are specialist, and
 * those stay where they are.
 */

import type { Paise, PersonId } from '../domain/index.js';
import type { Executor } from '../db/index.js';

import { getCategorySpend, getMonthlySpend, getOwnSpend } from './analytics-service.js';
import type {
  AnalyticsCaveats,
  AnalyticsPeriod,
  CategorySpend,
  MonthlySpend,
} from './analytics-service.js';
import { getOverview } from './overview-service.js';
import type { OverviewActivity, OverviewFigure } from './overview-service.js';

export interface SpendingSummaryResult {
  readonly period: AnalyticsPeriod;
  /** The one hero figure: what this period's approved expenses came to, net of refunds. */
  readonly total: OverviewFigure;
  readonly categories: readonly CategorySpend[];
  /** Month by month, oldest first. A trend, not a forecast — nothing here predicts. */
  readonly months: readonly MonthlySpend[];
  readonly own: {
    /** What the user's own share came to, once shares with other people are taken out. */
    readonly share: Paise;
    /** What passed through their accounts for expenses in this period, whoever benefited. */
    readonly paidByYou: Paise;
    /** Fronted for other people and not yet repaid in this period's expenses. */
    readonly frontedForOthers: Paise;
  };
  /**
   * Money that came back against this period's expenses.
   *
   * `grossTotal - netTotal` over the same rows — `domain.netAmount`'s own answer read off the
   * category read, never a second traversal of the adjustment table.
   */
  readonly cameBack: { readonly total: Paise };
  /** The unaccounted figure and the movements behind it, straight from the overview read. */
  readonly unaccountedFor: {
    readonly total: OverviewFigure;
    readonly movementCount: number;
    readonly movements: readonly OverviewActivity[];
  };
  /** What every total above leaves out, stated rather than implied. */
  readonly caveats: AnalyticsCaveats;
}

export interface SpendingSummaryInput {
  readonly userPersonId: PersonId;
  readonly period: AnalyticsPeriod;
  /** How many months of trend to return, newest last. */
  readonly months?: number;
}

const DEFAULT_TREND_MONTHS = 6;

export async function getSpendingSummary(
  db: Executor,
  input: SpendingSummaryInput,
): Promise<SpendingSummaryResult> {
  const trendPeriod = trailingMonths(input.period, input.months ?? DEFAULT_TREND_MONTHS);

  const [categories, monthly, own, overview] = await Promise.all([
    getCategorySpend(db, input.period),
    getMonthlySpend(db, trendPeriod),
    getOwnSpend(db, input.userPersonId, input.period),
    getOverview(db, { userPersonId: input.userPersonId, period: input.period }),
  ]);

  return {
    period: input.period,
    total: overview.spending.total,
    categories: categories.categories,
    months: monthly.months,
    own: {
      share: own.ownShare,
      paidByYou: own.paidByUser,
      frontedForOthers: own.frontedForOthers,
    },
    // `netTotal` is already net of adjustments and `grossTotal` is not, so the difference is
    // exactly what came back — `domain.netAmount`'s answer, read off the same row rather than
    // recomputed from the adjustment table.
    cameBack: { total: (categories.grossTotal - categories.netTotal) as Paise },
    unaccountedFor: {
      total: overview.unexplained.total,
      movementCount: overview.unexplained.movementCount,
      movements: overview.unexplained.movements,
    },
    caveats: categories.caveats,
  };
}

/**
 * The window a trend covers: `months` calendar months ending with the period's own month.
 *
 * Built from the period rather than from the clock, so a caller asking about July gets a trend
 * ending in July. UTC month boundaries, like every other period in this system.
 */
function trailingMonths(period: AnalyticsPeriod, months: number): AnalyticsPeriod {
  const end = period.end;
  const start = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - Math.max(1, months) + 1, 1),
  );
  return { start, end };
}
