/**
 * The aggregate reads analytics needs (audit rows 30 and 44).
 *
 * Aggregation only — `sum`, `count`, `group by`. Every figure that *means* something
 * financially is still computed by `src/domain`: this returns gross totals and adjustment
 * totals side by side so `domain.netAmount` can subtract them, rather than doing the
 * subtraction in SQL where a second definition of "net" would quietly grow.
 *
 * The one thing these queries do decide is **scope**, and they decide it the way
 * `invariants.md` #20 does: `ledger_*` buckets enumerate the states they sum, starting at
 * `approved`. A `proposed` or `rejected` expense is not spending.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';

import type { ExpenseAdjustmentId, ExpenseId, PersonId } from '../domain/ids.js';
import type { Paise } from '../domain/money.js';

import { ACTIVE_ADJUSTMENT } from './repositories.js';
import type { Executor } from './repositories.js';
import {
  allocationLineGroupExpansions,
  allocationLines,
  allocations,
  expenseAdjustments,
  expenses,
  payments,
  people,
  settlements,
} from './schema.js';

/**
 * The expense states that count as spending.
 *
 * `approved` onwards, exactly as every `ledger_*` total enumerates (`invariants.md` #20).
 * `proposed`, `classified` and `review_required` are not decisions yet; `rejected` is a
 * decision that it did not happen.
 */
const COUNTED_STATES = ['approved', 'allocated', 'ready_to_sync', 'synced', 'reconciled'];

export interface AnalyticsPeriodInput {
  readonly start: Date;
  readonly end: Date;
}

function inPeriod(period: AnalyticsPeriodInput) {
  return and(
    inArray(expenses.state, COUNTED_STATES),
    gte(expenses.occurredAt, period.start),
    lt(expenses.occurredAt, period.end),
  );
}

/** Per-expense adjustment totals for a set of expenses, so `domain.netAmount` can subtract. */
async function adjustmentTotals(
  exec: Executor,
  expenseIds: readonly string[],
): Promise<Map<string, bigint>> {
  if (expenseIds.length === 0) return new Map();
  const rows = await exec
    .select({
      expenseId: expenseAdjustments.originalExpenseId,
      total: sql<string>`coalesce(sum(${expenseAdjustments.amount}), 0)`,
    })
    .from(expenseAdjustments)
    // A reversed adjustment never reduced anything, so it must not reduce an analytics
    // figure either (ADR-0052).
    .where(and(inArray(expenseAdjustments.originalExpenseId, [...expenseIds]), ACTIVE_ADJUSTMENT))
    .groupBy(expenseAdjustments.originalExpenseId);
  return new Map(rows.map((row) => [row.expenseId, BigInt(row.total)]));
}

export interface CategorySpendRow {
  readonly category: string | null;
  readonly grossTotal: Paise;
  readonly adjustmentTotal: Paise;
  readonly expenseCount: number;
  readonly expenseIds: readonly ExpenseId[];
}

export async function loadCategorySpendRows(
  exec: Executor,
  period: AnalyticsPeriodInput,
): Promise<CategorySpendRow[]> {
  const rows = await exec
    .select({
      id: expenses.id,
      category: expenses.category,
      amount: expenses.amount,
    })
    .from(expenses)
    .where(inPeriod(period));

  const adjustments = await adjustmentTotals(
    exec,
    rows.map((row) => row.id),
  );

  const byCategory = new Map<string | null, CategorySpendRow>();
  for (const row of rows) {
    const existing = byCategory.get(row.category) ?? {
      category: row.category,
      grossTotal: 0n as Paise,
      adjustmentTotal: 0n as Paise,
      expenseCount: 0,
      expenseIds: [] as ExpenseId[],
    };
    byCategory.set(row.category, {
      category: row.category,
      grossTotal: (existing.grossTotal + (row.amount as Paise)) as Paise,
      adjustmentTotal: (existing.adjustmentTotal + (adjustments.get(row.id) ?? 0n)) as Paise,
      expenseCount: existing.expenseCount + 1,
      expenseIds: [...existing.expenseIds, row.id as ExpenseId],
    });
  }
  return [...byCategory.values()];
}

export interface MonthlySpendRow {
  readonly month: string;
  readonly grossTotal: Paise;
  readonly adjustmentTotal: Paise;
  readonly expenseCount: number;
  readonly expenseIds: readonly ExpenseId[];
}

export async function loadMonthlySpendRows(
  exec: Executor,
  period: AnalyticsPeriodInput,
): Promise<MonthlySpendRow[]> {
  const rows = await exec
    .select({ id: expenses.id, occurredAt: expenses.occurredAt, amount: expenses.amount })
    .from(expenses)
    .where(inPeriod(period))
    .orderBy(asc(expenses.occurredAt));

  const adjustments = await adjustmentTotals(
    exec,
    rows.map((row) => row.id),
  );

  const byMonth = new Map<string, MonthlySpendRow>();
  for (const row of rows) {
    // UTC, matching every other period boundary in this system — a month that shifted with
    // the reader's timezone would put the same expense in two different months.
    const month = row.occurredAt.toISOString().slice(0, 7);
    const existing = byMonth.get(month) ?? {
      month,
      grossTotal: 0n as Paise,
      adjustmentTotal: 0n as Paise,
      expenseCount: 0,
      expenseIds: [] as ExpenseId[],
    };
    byMonth.set(month, {
      month,
      grossTotal: (existing.grossTotal + (row.amount as Paise)) as Paise,
      adjustmentTotal: (existing.adjustmentTotal + (adjustments.get(row.id) ?? 0n)) as Paise,
      expenseCount: existing.expenseCount + 1,
      expenseIds: [...existing.expenseIds, row.id as ExpenseId],
    });
  }
  return [...byMonth.values()];
}

/** The counted expenses in a period, with the payer and the net inputs the domain needs. */
export interface PeriodExpenseRow {
  readonly expenseId: ExpenseId;
  readonly paidByPersonId: PersonId;
  readonly grossAmount: Paise;
  readonly adjustmentTotal: Paise;
}

export async function loadPeriodExpenses(
  exec: Executor,
  period: AnalyticsPeriodInput,
): Promise<PeriodExpenseRow[]> {
  const rows = await exec
    .select({
      id: expenses.id,
      paidByPersonId: expenses.paidByPersonId,
      amount: expenses.amount,
    })
    .from(expenses)
    .where(inPeriod(period));

  const adjustments = await adjustmentTotals(
    exec,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    expenseId: row.id as ExpenseId,
    paidByPersonId: row.paidByPersonId as PersonId,
    grossAmount: row.amount as Paise,
    adjustmentTotal: (adjustments.get(row.id) ?? 0n) as Paise,
  }));
}

/** One counterparty's standing balance with the user, and how many expenses contribute. */
export interface CounterpartyBalanceRow {
  readonly personId: PersonId;
  readonly displayName: string;
  readonly netBalance: Paise;
  readonly contributingExpenseCount: number;
}

/**
 * Every person the user has an obligation with, netted against recorded settlements.
 *
 * Reads the same three sources `domain.computeNetBalance` does — current allocation lines,
 * their group expansions, and settlements — and applies the same sign convention: positive
 * means they owe the user. The traversal is here rather than in the service because it spans
 * every counterparty at once; the arithmetic it performs is addition of already-authoritative
 * line amounts, not a financial rule.
 */
export async function loadCounterpartyBalanceRows(
  exec: Executor,
  userPersonId: PersonId,
): Promise<CounterpartyBalanceRow[]> {
  const lineRows = await exec
    .select({
      expenseId: allocations.expenseId,
      paidByPersonId: expenses.paidByPersonId,
      beneficiaryType: allocationLines.beneficiaryType,
      beneficiaryId: allocationLines.beneficiaryId,
      amount: allocationLines.amount,
      expansionPersonId: allocationLineGroupExpansions.personId,
      expansionAmount: allocationLineGroupExpansions.amount,
    })
    .from(allocations)
    .innerJoin(expenses, eq(expenses.id, allocations.expenseId))
    .innerJoin(allocationLines, eq(allocationLines.allocationId, allocations.id))
    .leftJoin(
      allocationLineGroupExpansions,
      eq(allocationLineGroupExpansions.allocationLineId, allocationLines.id),
    )
    .where(and(isNull(allocations.supersededAt), inArray(expenses.state, COUNTED_STATES)));

  const balances = new Map<string, { net: bigint; expenses: Set<string> }>();
  const bump = (personId: string, amount: bigint, expenseId: string): void => {
    const entry = balances.get(personId) ?? { net: 0n, expenses: new Set<string>() };
    entry.net += amount;
    entry.expenses.add(expenseId);
    balances.set(personId, entry);
  };

  for (const row of lineRows) {
    // A group line's own amount is never an obligation: only its expansion rows are, and a
    // group is never a debtor (ADR-0009, `invariants.md` #2b).
    const isGroupLine = row.beneficiaryType === 'group';
    const personId = isGroupLine ? row.expansionPersonId : row.beneficiaryId;
    const amount = isGroupLine ? row.expansionAmount : row.amount;
    if (personId === null || amount === null) continue;
    if (personId === row.paidByPersonId) continue;

    if (row.paidByPersonId === userPersonId && personId !== userPersonId) {
      bump(personId, amount, row.expenseId);
    } else if (personId === userPersonId && row.paidByPersonId !== userPersonId) {
      bump(row.paidByPersonId, -amount, row.expenseId);
    }
  }

  const settlementRows = await exec
    .select({
      counterpartyPersonId: settlements.counterpartyPersonId,
      amount: settlements.amount,
      direction: payments.direction,
    })
    .from(settlements)
    .innerJoin(payments, eq(payments.id, settlements.paymentId));

  for (const row of settlementRows) {
    const entry = balances.get(row.counterpartyPersonId) ?? { net: 0n, expenses: new Set() };
    // A debit is the user paying the counterparty, which reduces what the user owes them —
    // so it moves the balance the same direction as their owing the user less.
    entry.net += row.direction === 'debit' ? row.amount : -row.amount;
    balances.set(row.counterpartyPersonId, entry);
  }

  balances.delete(userPersonId);
  if (balances.size === 0) return [];

  const names = await exec
    .select({ id: people.id, displayName: people.displayName })
    .from(people)
    .where(inArray(people.id, [...balances.keys()]));
  const nameById = new Map(names.map((row) => [row.id, row.displayName]));

  return [...balances.entries()]
    .map(([personId, entry]) => ({
      personId: personId as PersonId,
      displayName: nameById.get(personId) ?? 'Unknown person',
      netBalance: entry.net as Paise,
      contributingExpenseCount: entry.expenses.size,
    }))
    .sort((a, b) => (b.netBalance > a.netBalance ? 1 : b.netBalance < a.netBalance ? -1 : 0));
}

/** One expense the user paid for that other people still have a share of. */
export interface UnsettledPaidOnBehalfRow {
  readonly expenseId: ExpenseId;
  readonly description: string | null;
  readonly occurredAt: Date;
  readonly netAmount: Paise;
  readonly owedToUser: Paise;
  readonly beneficiaries: readonly { readonly personId: PersonId; readonly displayName: string }[];
}

export async function loadUnsettledPaidOnBehalfRows(
  exec: Executor,
  userPersonId: PersonId,
): Promise<UnsettledPaidOnBehalfRow[]> {
  const rows = await exec
    .select({
      expenseId: expenses.id,
      description: expenses.description,
      occurredAt: expenses.occurredAt,
      beneficiaryType: allocationLines.beneficiaryType,
      beneficiaryId: allocationLines.beneficiaryId,
      amount: allocationLines.amount,
      expansionPersonId: allocationLineGroupExpansions.personId,
      expansionAmount: allocationLineGroupExpansions.amount,
    })
    .from(expenses)
    .innerJoin(
      allocations,
      and(eq(allocations.expenseId, expenses.id), isNull(allocations.supersededAt)),
    )
    .innerJoin(allocationLines, eq(allocationLines.allocationId, allocations.id))
    .leftJoin(
      allocationLineGroupExpansions,
      eq(allocationLineGroupExpansions.allocationLineId, allocationLines.id),
    )
    .where(and(eq(expenses.paidByPersonId, userPersonId), inArray(expenses.state, COUNTED_STATES)))
    .orderBy(asc(expenses.occurredAt));

  const byExpense = new Map<
    string,
    {
      description: string | null;
      occurredAt: Date;
      owed: bigint;
      lineTotal: bigint;
      beneficiaries: Map<string, true>;
    }
  >();

  for (const row of rows) {
    const entry = byExpense.get(row.expenseId) ?? {
      description: row.description,
      occurredAt: row.occurredAt,
      owed: 0n,
      lineTotal: 0n,
      beneficiaries: new Map<string, true>(),
    };
    const isGroupLine = row.beneficiaryType === 'group';
    const personId = isGroupLine ? row.expansionPersonId : row.beneficiaryId;
    const amount = isGroupLine ? row.expansionAmount : row.amount;
    if (personId !== null && amount !== null) {
      entry.lineTotal += amount;
      if (personId !== userPersonId) {
        entry.owed += amount;
        entry.beneficiaries.set(personId, true);
      }
    }
    byExpense.set(row.expenseId, entry);
  }

  const withDebt = [...byExpense.entries()].filter(([, entry]) => entry.owed > 0n);
  if (withDebt.length === 0) return [];

  const personIds = [...new Set(withDebt.flatMap(([, entry]) => [...entry.beneficiaries.keys()]))];
  const names = await exec
    .select({ id: people.id, displayName: people.displayName })
    .from(people)
    .where(inArray(people.id, personIds));
  const nameById = new Map(names.map((row) => [row.id, row.displayName]));

  return withDebt.map(([expenseId, entry]) => ({
    expenseId: expenseId as ExpenseId,
    description: entry.description,
    occurredAt: entry.occurredAt,
    // The current allocation sums to the expense's net amount (`invariants.md` #11), so the
    // line total *is* the net — quoted from the approved split rather than recomputed.
    netAmount: entry.lineTotal as Paise,
    owedToUser: entry.owed as Paise,
    beneficiaries: [...entry.beneficiaries.keys()].map((personId) => ({
      personId: personId as PersonId,
      displayName: nameById.get(personId) ?? 'Unknown person',
    })),
  }));
}

/**
 * Every adjustment recorded in a period, with the expense it reduced (ADR-0057).
 *
 * Added because an answer needed a figure no read produced — which is the rule this repository
 * follows wherever a surface is short of one (ADR-0048): the read gets added here, never the
 * arithmetic to the surface. Reversed rows come back marked rather than filtered, because a
 * question about "the refunds last month" is asking what was recorded, and a ledger that hid
 * its own corrections would be rewriting its past (`invariants.md` #22).
 */
export async function listExpenseAdjustmentsInPeriod(
  exec: Executor,
  period: { readonly start: Date; readonly end: Date },
  options: { readonly limit?: number } = {},
): Promise<
  Array<{
    adjustmentId: ExpenseAdjustmentId;
    expenseId: ExpenseId;
    expenseDescription: string | null;
    kind: string;
    amount: Paise;
    reason: string | null;
    occurredAt: Date;
    reversedAt: Date | null;
    /** Whether an allocation reflects this adjustment yet — a pending one moves a net. */
    distributed: boolean;
  }>
> {
  const rows = await exec
    .select({
      adjustmentId: expenseAdjustments.id,
      expenseId: expenseAdjustments.originalExpenseId,
      expenseDescription: expenses.description,
      kind: expenseAdjustments.kind,
      amount: expenseAdjustments.amount,
      reason: expenseAdjustments.reason,
      occurredAt: expenseAdjustments.occurredAt,
      reversedAt: expenseAdjustments.reversedAt,
      allocationSupersededAt: allocations.supersededAt,
      allocationCreatedAt: allocations.createdAt,
    })
    .from(expenseAdjustments)
    .innerJoin(expenses, eq(expenses.id, expenseAdjustments.originalExpenseId))
    .leftJoin(
      allocations,
      and(
        eq(allocations.expenseId, expenseAdjustments.originalExpenseId),
        isNull(allocations.supersededAt),
      ),
    )
    .where(
      and(
        sql`${expenseAdjustments.occurredAt} >= ${period.start}`,
        sql`${expenseAdjustments.occurredAt} < ${period.end}`,
      ),
    )
    .orderBy(desc(expenseAdjustments.occurredAt), asc(expenseAdjustments.id))
    .limit(options.limit ?? 100);

  return rows.map((row) => ({
    adjustmentId: row.adjustmentId as ExpenseAdjustmentId,
    expenseId: row.expenseId as ExpenseId,
    expenseDescription: row.expenseDescription,
    kind: row.kind,
    amount: row.amount as Paise,
    reason: row.reason,
    occurredAt: row.occurredAt,
    reversedAt: row.reversedAt,
    // The current allocation post-dates the adjustment, so it was rebuilt knowing about it
    // (ADR-0045). A `null` allocation is an expense nobody has allocated at all.
    distributed:
      row.allocationCreatedAt !== null &&
      row.allocationCreatedAt.getTime() >= row.occurredAt.getTime(),
  }));
}

/** Categories in use on approved expenses, so a question can be planned against real ones. */
export async function listExpenseCategories(exec: Executor): Promise<string[]> {
  const rows = await exec
    .selectDistinct({ category: expenses.category })
    .from(expenses)
    .where(and(sql`${expenses.category} is not null`, sql`${expenses.state} <> 'rejected'`))
    .orderBy(asc(expenses.category));
  return rows.flatMap((row) => (row.category === null ? [] : [row.category]));
}
