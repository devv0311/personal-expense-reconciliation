/**
 * Analytics — the questions the audit's row 44 named and no read answered: *"own spend last
 * month"*, *"every unreimbursed paid-on-behalf expense"*, spending by category, by person and
 * over time, and who currently owes whom across everybody rather than one pair at a time.
 *
 * Two rules shape all of it.
 *
 * **Every figure is the ledger's own, aggregated — never re-derived.** A category total sums
 * `netAmount`, the same figure the ledger row shows. "What I actually spent" sums the current
 * allocation lines that name the user, which is the same arithmetic `domain.computeObligations`
 * already performs — so an analytics screen and a balance screen can never disagree, because
 * they are adding up the same rows.
 *
 * **A total that excludes something says so.** Every result carries what it counted and what
 * it deliberately did not: rejected expenses, transfers, investments, and — most importantly —
 * expenses with a pending refund distribution, whose net is about to move. A number that
 * quietly drops rows is worse than no number.
 */

import { computeObligations, netAmount } from '../domain/index.js';
import type { ExpenseId, Paise, PersonId } from '../domain/index.js';
import {
  loadBalanceInput,
  loadCategorySpendRows,
  loadCounterpartyBalanceRows,
  loadExpenseDistributionTotals,
  loadMonthlySpendRows,
  loadPeriodExpenses,
  loadUnsettledPaidOnBehalfRows,
} from '../db/index.js';
import type { Executor } from '../db/index.js';

/** The period every analytics read is scoped to. End is exclusive, as everywhere else. */
export interface AnalyticsPeriod {
  readonly start: Date;
  /** Exclusive. */
  readonly end: Date;
}

/**
 * What an aggregate deliberately leaves out, carried with every result.
 *
 * Not decoration. `invariants.md` #7 excludes transfers and investments from spending, #20
 * excludes rejected expenses from every total, and a pending refund distribution means an
 * expense's net is about to change. A screen that shows a total without these caveats is
 * asserting more precision than the ledger has.
 */
export interface AnalyticsCaveats {
  /** Expenses in this period whose recorded refund no allocation reflects yet. */
  readonly pendingRefundExpenseIds: readonly ExpenseId[];
  /** Stated for the reader: what a spend total never includes. */
  readonly excludes: readonly string[];
}

const STANDING_EXCLUSIONS = [
  'rejected expenses (invariants.md #20)',
  'transfers between own accounts (invariants.md #7)',
  'investment purchases (ADR-0011)',
  'settlements, which discharge a debt rather than creating spend (ADR-0007)',
] as const;

/* ============================================================== spending by category */

export interface CategorySpend {
  readonly category: string | null;
  /** Sums `netAmount` — gross minus adjustments — never the gross figure (ADR-0008). */
  readonly netTotal: Paise;
  readonly grossTotal: Paise;
  readonly expenseCount: number;
}

export interface CategorySpendResult {
  readonly period: AnalyticsPeriod;
  readonly categories: readonly CategorySpend[];
  readonly netTotal: Paise;
  readonly caveats: AnalyticsCaveats;
}

/**
 * Approved spending in a period, by category.
 *
 * Counts the **whole** expense, not the user's share of it: this answers "what went through
 * this ledger on food", which is a different question from "what food cost me". The second is
 * {@link getOwnSpend}, and keeping them apart is why neither can be mistaken for the other.
 */
export async function getCategorySpend(
  db: Executor,
  period: AnalyticsPeriod,
): Promise<CategorySpendResult> {
  const rows = await loadCategorySpendRows(db, period);
  const categories = rows.map((row) => ({
    category: row.category,
    grossTotal: row.grossTotal,
    netTotal: netAmount(row.grossTotal, [row.adjustmentTotal]),
    expenseCount: row.expenseCount,
  }));
  const total = categories.reduce<bigint>((sum, entry) => sum + entry.netTotal, 0n);

  return {
    period,
    categories: [...categories].sort((a, b) => (b.netTotal > a.netTotal ? 1 : -1)),
    netTotal: total as Paise,
    caveats: await buildCaveats(
      db,
      rows.flatMap((row) => row.expenseIds),
    ),
  };
}

/* ================================================================= spending over time */

export interface MonthlySpend {
  /** `YYYY-MM`, in UTC — the same instant boundary every period in this system uses. */
  readonly month: string;
  readonly netTotal: Paise;
  readonly expenseCount: number;
}

export interface MonthlySpendResult {
  readonly period: AnalyticsPeriod;
  readonly months: readonly MonthlySpend[];
  readonly caveats: AnalyticsCaveats;
}

/** Approved spending per calendar month, oldest first — the trend row 44 asked for. */
export async function getMonthlySpend(
  db: Executor,
  period: AnalyticsPeriod,
): Promise<MonthlySpendResult> {
  const rows = await loadMonthlySpendRows(db, period);
  return {
    period,
    months: rows.map((row) => ({
      month: row.month,
      netTotal: netAmount(row.grossTotal, [row.adjustmentTotal]),
      expenseCount: row.expenseCount,
    })),
    caveats: await buildCaveats(
      db,
      rows.flatMap((row) => row.expenseIds),
    ),
  };
}

/* ======================================================================= own spending */

export interface OwnSpendResult {
  readonly period: AnalyticsPeriod;
  /**
   * The user's own share — the sum of current allocation lines naming them, expanded past any
   * group line exactly as an obligation is (ADR-0009).
   *
   * This is "what I actually spent", as distinct from what passed through the account.
   */
  readonly ownShare: Paise;
  /** What the user paid out for expenses in this period, whoever ultimately benefited. */
  readonly paidByUser: Paise;
  /**
   * `paidByUser - ownShare` — what the user fronted for other people in this period, before
   * any repayment. Not a balance: repayments are netted by `services.getBalance`.
   */
  readonly frontedForOthers: Paise;
  readonly caveats: AnalyticsCaveats;
}

/**
 * What the user's own share of this period's spending came to.
 *
 * Built from `domain.computeObligations`'s own input, so the share here and the obligations on
 * the balances page are the same arithmetic over the same rows. An analytics figure that
 * disagreed with a balance would be worse than no analytics.
 */
export async function getOwnSpend(
  db: Executor,
  userPersonId: PersonId,
  period: AnalyticsPeriod,
): Promise<OwnSpendResult> {
  const [input, periodExpenses] = await Promise.all([
    loadBalanceInput(db, userPersonId),
    loadPeriodExpenses(db, period),
  ]);

  const inPeriod = new Set<string>(periodExpenses.map((expense) => expense.expenseId));
  const paidByUser = periodExpenses
    .filter((expense) => expense.paidByPersonId === userPersonId)
    .reduce<bigint>(
      (sum, expense) => sum + netAmount(expense.grossAmount, [expense.adjustmentTotal]),
      0n,
    );

  // `computeObligations` over the whole ledger, then narrowed to this period's expenses by
  // id. Deliberately not a second traversal of the allocation lines: the obligations here and
  // the obligations on the balances page are literally the same objects, so an analytics
  // figure can never disagree with a balance.
  const obligations = computeObligations(input).filter((obligation) =>
    inPeriod.has(obligation.expenseId),
  );
  const owedToUser = obligations
    .filter((obligation) => obligation.creditorId === userPersonId)
    .reduce<bigint>((sum, obligation) => sum + obligation.amount, 0n);
  // What the user owes others for this period's expenses is part of their own share too: a
  // flatmate paying the electricity does not make it somebody else's electricity.
  const owedByUser = obligations
    .filter((obligation) => obligation.debtorId === userPersonId)
    .reduce<bigint>((sum, obligation) => sum + obligation.amount, 0n);

  const ownShare = paidByUser - owedToUser + owedByUser;

  return {
    period,
    ownShare: ownShare as Paise,
    paidByUser: paidByUser as Paise,
    frontedForOthers: owedToUser as Paise,
    caveats: await buildCaveats(
      db,
      periodExpenses.map((expense) => expense.expenseId),
    ),
  };
}

/* ================================================== who owes whom, across everybody */

export interface CounterpartyBalance {
  readonly personId: PersonId;
  readonly displayName: string;
  /** Positive: they owe the user. Negative: the user owes them. */
  readonly netBalance: Paise;
  readonly contributingExpenseCount: number;
}

export interface OutstandingResult {
  readonly counterparties: readonly CounterpartyBalance[];
  /** Everything owed **to** the user, and everything the user owes, as two totals. */
  readonly totalOwedToUser: Paise;
  readonly totalOwedByUser: Paise;
  readonly caveats: AnalyticsCaveats;
}

/**
 * Every open balance at once — the "all-counterparties debt dashboard" row 30 found missing.
 *
 * Built from the same `computeObligations`/settlement arithmetic `getBalance` performs for one
 * pair, applied across everybody. Anyone whose net is exactly zero is omitted: a settled
 * counterparty is not an outstanding balance, and listing them as ₹0 would bury the ones that
 * are not.
 */
export async function getOutstandingBalances(
  db: Executor,
  userPersonId: PersonId,
): Promise<OutstandingResult> {
  const rows = await loadCounterpartyBalanceRows(db, userPersonId);
  const counterparties = rows.filter((row) => row.netBalance !== 0n);

  return {
    counterparties,
    totalOwedToUser: counterparties
      .filter((row) => row.netBalance > 0n)
      .reduce<bigint>((sum, row) => sum + row.netBalance, 0n) as Paise,
    totalOwedByUser: counterparties
      .filter((row) => row.netBalance < 0n)
      .reduce<bigint>((sum, row) => sum - row.netBalance, 0n) as Paise,
    caveats: await buildCaveats(db, []),
  };
}

/* ============================================== paid on behalf and not yet reimbursed */

export interface UnsettledPaidOnBehalf {
  readonly expenseId: ExpenseId;
  readonly description: string | null;
  readonly occurredAt: Date;
  readonly netAmount: Paise;
  /** What other people still owe on this expense, before any settlement between the pair. */
  readonly owedToUser: Paise;
  readonly beneficiaries: readonly { readonly personId: PersonId; readonly displayName: string }[];
}

export interface UnsettledResult {
  readonly expenses: readonly UnsettledPaidOnBehalf[];
  readonly totalOwedToUser: Paise;
  readonly caveats: AnalyticsCaveats;
}

/**
 * Every expense the user paid for that somebody else still has a share of (row 44).
 *
 * Per **expense**, deliberately, where {@link getOutstandingBalances} is per person. A
 * settlement discharges a balance, not one particular expense (ADR-0007), so this cannot say
 * "this expense was repaid" — it says what each expense contributed, and the person-level
 * netting is the other read's job. Presenting these as "unreimbursed" after a settlement would
 * be attributing a repayment to a row it was never attached to.
 */
export async function getUnsettledPaidOnBehalf(
  db: Executor,
  userPersonId: PersonId,
): Promise<UnsettledResult> {
  const expenses = await loadUnsettledPaidOnBehalfRows(db, userPersonId);
  return {
    expenses,
    totalOwedToUser: expenses.reduce<bigint>(
      (sum, expense) => sum + expense.owedToUser,
      0n,
    ) as Paise,
    caveats: await buildCaveats(
      db,
      expenses.map((expense) => expense.expenseId),
    ),
  };
}

/* --------------------------------------------------------------------------- internals */

async function buildCaveats(
  db: Executor,
  expenseIds: readonly ExpenseId[],
): Promise<AnalyticsCaveats> {
  const unique = [...new Set(expenseIds)];
  const totals = await loadExpenseDistributionTotals(db, unique);
  const pending = totals
    .filter((row) => {
      if (!row.hasCurrentAllocation) return false;
      const net = netAmount(row.grossAmount, [row.adjustmentTotal]);
      return row.currentLineTotal > net;
    })
    .map((row) => row.expenseId);

  return { pendingRefundExpenseIds: pending, excludes: STANDING_EXCLUSIONS };
}
