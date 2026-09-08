/**
 * The payment workspace's reads: every posted movement, filterable, and the import batches
 * that produced them.
 *
 * The audit's rows 32/36 named the gap: *"no general payments listing API"*, so the cash
 * waterfall's credit and debit terms were "not clickable movement lists" and "Review is not an
 * exhaustive list of unexplained bank movements". A waterfall term you cannot open is a number
 * you have to take on trust, which is exactly what this system exists not to ask of anyone.
 *
 * Reads only, and no arithmetic: each row carries its raw attribution totals so
 * `domain.explainedAmount` — the one function that decides what "explained" means — stays the
 * only place that decides it (`invariants.md`, and `system-architecture.md`'s layering rule).
 */

import { and, asc, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import type {
  CashFlowCategory,
  CashFlowState,
  PaymentCounterpartyType,
  PaymentDirection,
  PaymentState,
} from '../domain/enums.js';
import type { AccountId, ImportBatchId, MerchantId, PaymentId, PersonId } from '../domain/ids.js';
import type { Paise } from '../domain/money.js';

import type { Executor } from './repositories.js';
import {
  accounts,
  evidence,
  expenseAdjustments,
  importBatches,
  merchants,
  paymentExpenseLinks,
  payments,
  people,
  settlements,
} from './schema.js';

/* ==================================================================== import batches */

export interface ImportBatchSummaryRow {
  readonly id: ImportBatchId;
  readonly sourceChannel: string;
  readonly fileReference: string | null;
  readonly contentHash: string | null;
  readonly parserVersion: string | null;
  readonly rowCount: number | null;
  readonly importedAt: Date;
  /** Payments actually written by this batch, and how many were marked as known copies. */
  readonly paymentCount: number;
  readonly ignoredCount: number;
}

/**
 * Import history, newest first — what was loaded, when, and how much of it was a duplicate.
 *
 * The two counts come from one grouped aggregate rather than correlated sub-selects: a
 * sub-select referencing the outer row does not correlate through Drizzle's `sql` template
 * here, and a count that silently returns zero is worse than no count at all.
 */
export async function listImportBatches(
  exec: Executor,
  options: { readonly limit?: number; readonly offset?: number } = {},
): Promise<ImportBatchSummaryRow[]> {
  const rows = await exec
    .select({
      id: importBatches.id,
      sourceChannel: importBatches.sourceChannel,
      fileReference: importBatches.fileReference,
      contentHash: importBatches.contentHash,
      parserVersion: importBatches.parserVersion,
      rowCount: importBatches.rowCount,
      importedAt: importBatches.importedAt,
    })
    .from(importBatches)
    .orderBy(desc(importBatches.importedAt), desc(importBatches.id))
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0);
  return withPaymentCounts(exec, rows);
}

/** Attaches each batch's payment/ignored counts, in one grouped query for the whole page. */
async function withPaymentCounts(
  exec: Executor,
  rows: ReadonlyArray<{
    id: string;
    sourceChannel: string;
    fileReference: string | null;
    contentHash: string | null;
    parserVersion: string | null;
    rowCount: number | null;
    importedAt: Date;
  }>,
): Promise<ImportBatchSummaryRow[]> {
  if (rows.length === 0) return [];
  const counts = await exec
    .select({
      importBatchId: payments.importBatchId,
      paymentCount: sql<number>`count(*)::int`,
      ignoredCount: sql<number>`count(*) filter (where ${payments.state} = 'ignored')::int`,
    })
    .from(payments)
    .where(
      inArray(
        payments.importBatchId,
        rows.map((row) => row.id),
      ),
    )
    .groupBy(payments.importBatchId);

  const byBatch = new Map(
    counts.map((row) => [
      row.importBatchId,
      { paymentCount: Number(row.paymentCount), ignoredCount: Number(row.ignoredCount) },
    ]),
  );
  return rows.map((row) => ({
    ...row,
    id: row.id as ImportBatchId,
    paymentCount: byBatch.get(row.id)?.paymentCount ?? 0,
    ignoredCount: byBatch.get(row.id)?.ignoredCount ?? 0,
  }));
}

export async function countImportBatches(exec: Executor): Promise<number> {
  const [row] = await exec.select({ total: sql<number>`count(*)::int` }).from(importBatches);
  return Number(row?.total ?? 0);
}

export async function getImportBatchById(
  exec: Executor,
  importBatchId: ImportBatchId,
): Promise<ImportBatchSummaryRow | null> {
  const rows = await exec
    .select({
      id: importBatches.id,
      sourceChannel: importBatches.sourceChannel,
      fileReference: importBatches.fileReference,
      contentHash: importBatches.contentHash,
      parserVersion: importBatches.parserVersion,
      rowCount: importBatches.rowCount,
      importedAt: importBatches.importedAt,
    })
    .from(importBatches)
    .where(eq(importBatches.id, importBatchId));
  const [summary] = await withPaymentCounts(exec, rows);
  return summary ?? null;
}

/* ========================================================================= payments */

/**
 * What a payment workspace can narrow by.
 *
 * `explained` is deliberately absent: whether a movement is explained is a domain conclusion
 * (`domain.explainedAmount`), so it is applied by the service over the returned attribution
 * totals rather than guessed at in SQL — the alternative would be a second, subtly different
 * definition of "explained" living in a `WHERE` clause.
 */
export interface PaymentWorkspaceFilter {
  /** One payment by id — the same projection a list row has, for a detail screen. */
  readonly paymentId?: PaymentId;
  readonly accountId?: AccountId;
  readonly importBatchId?: ImportBatchId;
  readonly direction?: PaymentDirection;
  readonly state?: PaymentState;
  readonly cashFlowState?: CashFlowState;
  readonly cashFlowCategory?: CashFlowCategory;
  readonly counterpartyType?: PaymentCounterpartyType;
  /** Case-insensitive substring of the immutable raw narration or the external reference. */
  readonly search?: string;
  readonly occurredFrom?: Date;
  /** Exclusive, matching every other period boundary in this system. */
  readonly occurredTo?: Date;
  readonly limit?: number;
  readonly offset?: number;
}

export interface PaymentWorkspaceRow {
  readonly id: PaymentId;
  readonly accountId: AccountId;
  readonly accountName: string;
  readonly importBatchId: ImportBatchId;
  readonly amount: Paise;
  readonly currency: string;
  readonly direction: PaymentDirection;
  readonly occurredAt: Date;
  /** Immutable SOURCE text, never an interpretation of it (`invariants.md` #4). */
  readonly rawDescription: string;
  readonly channel: string;
  readonly counterpartyType: PaymentCounterpartyType;
  readonly counterpartyId: string | null;
  readonly counterpartyName: string | null;
  readonly externalReference: string | null;
  readonly referenceType: string | null;
  readonly sourceSystem: string | null;
  readonly state: PaymentState;
  readonly ignoredReason: string | null;
  readonly cashFlowCategory: CashFlowCategory | null;
  readonly cashFlowState: CashFlowState;
  readonly cashFlowApprovedAt: Date | null;
  readonly cashFlowApprovedBy: string | null;
  /** Raw attribution totals; `domain.explainedAmount` turns these into "explained". */
  readonly expenseLinkTotal: Paise;
  readonly settlementTotal: Paise;
  readonly adjustmentTotal: Paise;
  readonly evidenceCount: number;
  readonly expenseLinkCount: number;
  readonly settlementCount: number;
}

function buildConditions(filter: PaymentWorkspaceFilter): SQL[] {
  const conditions: SQL[] = [];
  if (filter.paymentId !== undefined) conditions.push(eq(payments.id, filter.paymentId));
  if (filter.accountId !== undefined) conditions.push(eq(payments.accountId, filter.accountId));
  if (filter.importBatchId !== undefined) {
    conditions.push(eq(payments.importBatchId, filter.importBatchId));
  }
  if (filter.direction !== undefined) conditions.push(eq(payments.direction, filter.direction));
  if (filter.state !== undefined) conditions.push(eq(payments.state, filter.state));
  if (filter.cashFlowState !== undefined) {
    conditions.push(eq(payments.cashFlowState, filter.cashFlowState));
  }
  if (filter.cashFlowCategory !== undefined) {
    conditions.push(eq(payments.cashFlowCategory, filter.cashFlowCategory));
  }
  if (filter.counterpartyType !== undefined) {
    conditions.push(eq(payments.counterpartyType, filter.counterpartyType));
  }
  if (filter.occurredFrom !== undefined) {
    conditions.push(gte(payments.occurredAt, filter.occurredFrom));
  }
  if (filter.occurredTo !== undefined) conditions.push(lt(payments.occurredAt, filter.occurredTo));
  if (filter.search !== undefined && filter.search.trim().length > 0) {
    const pattern = `%${filter.search.trim()}%`;
    // Server-side, so search covers the whole ledger rather than whatever a page happened to
    // load — the exact failure audit row 32 recorded for the expense ledger.
    const matches = or(
      sql`${payments.rawDescription} ilike ${pattern}`,
      sql`${payments.externalReference} ilike ${pattern}`,
    );
    if (matches !== undefined) conditions.push(matches);
  }
  return conditions;
}

export async function countPaymentsForWorkspace(
  exec: Executor,
  filter: PaymentWorkspaceFilter = {},
): Promise<number> {
  const conditions = buildConditions(filter);
  const query = exec.select({ total: sql<number>`count(*)::int` }).from(payments);
  const [row] = await (conditions.length === 0 ? query : query.where(and(...conditions)));
  return Number(row?.total ?? 0);
}

/**
 * One page of payments, newest first, with everything a workspace row renders.
 *
 * The four attribution figures are gathered in batched grouped queries over the page's ids
 * rather than joined in, for the reason `loadCashReconciliationInput` gives: a payment with
 * two expense links and a settlement would otherwise multiply its own row and inflate every
 * total on it.
 */
export async function listPaymentsForWorkspace(
  exec: Executor,
  filter: PaymentWorkspaceFilter = {},
): Promise<PaymentWorkspaceRow[]> {
  const conditions = buildConditions(filter);
  const base = exec
    .select({
      id: payments.id,
      accountId: payments.accountId,
      accountName: accounts.name,
      importBatchId: payments.importBatchId,
      amount: payments.amount,
      currency: payments.currency,
      direction: payments.direction,
      occurredAt: payments.occurredAt,
      rawDescription: payments.rawDescription,
      channel: payments.channel,
      counterpartyType: payments.counterpartyType,
      counterpartyId: payments.counterpartyId,
      merchantName: merchants.canonicalName,
      personName: people.displayName,
      externalReference: payments.externalReference,
      referenceType: payments.referenceType,
      sourceSystem: payments.sourceSystem,
      state: payments.state,
      ignoredReason: payments.ignoredReason,
      cashFlowCategory: payments.cashFlowCategory,
      cashFlowState: payments.cashFlowState,
      cashFlowApprovedAt: payments.cashFlowApprovedAt,
      cashFlowApprovedBy: payments.cashFlowApprovedBy,
    })
    .from(payments)
    .innerJoin(accounts, eq(accounts.id, payments.accountId))
    // Both joins are `left` and both are guarded by `counterparty_type`, because
    // `counterparty_id` is polymorphic: without the guard a merchant id would be looked up in
    // `people` too, and a collision would silently name the wrong counterparty.
    .leftJoin(
      merchants,
      and(eq(payments.counterpartyType, 'merchant'), eq(merchants.id, payments.counterpartyId)),
    )
    .leftJoin(
      people,
      and(eq(payments.counterpartyType, 'person'), eq(people.id, payments.counterpartyId)),
    );

  const rows = await (conditions.length === 0 ? base : base.where(and(...conditions)))
    .orderBy(desc(payments.occurredAt), asc(payments.id))
    .limit(filter.limit ?? 100)
    .offset(filter.offset ?? 0);

  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const [linkRows, settlementRows, adjustmentRows, evidenceRows] = await Promise.all([
    exec
      .select({
        paymentId: paymentExpenseLinks.paymentId,
        total: sql<string>`coalesce(sum(${paymentExpenseLinks.amount}), 0)`,
        count: sql<number>`count(*)::int`,
      })
      .from(paymentExpenseLinks)
      .where(inArray(paymentExpenseLinks.paymentId, ids))
      .groupBy(paymentExpenseLinks.paymentId),
    exec
      .select({
        paymentId: settlements.paymentId,
        total: sql<string>`coalesce(sum(${settlements.amount}), 0)`,
        count: sql<number>`count(*)::int`,
      })
      .from(settlements)
      .where(inArray(settlements.paymentId, ids))
      .groupBy(settlements.paymentId),
    exec
      .select({
        paymentId: expenseAdjustments.adjustmentPaymentId,
        total: sql<string>`coalesce(sum(${expenseAdjustments.amount}), 0)`,
        count: sql<number>`count(*)::int`,
      })
      .from(expenseAdjustments)
      .where(inArray(expenseAdjustments.adjustmentPaymentId, ids))
      .groupBy(expenseAdjustments.adjustmentPaymentId),
    exec
      .select({ paymentId: evidence.linkedPaymentId, count: sql<number>`count(*)::int` })
      .from(evidence)
      .where(inArray(evidence.linkedPaymentId, ids))
      .groupBy(evidence.linkedPaymentId),
  ]);

  const index = <T extends { paymentId: string | null }>(entries: T[]): Map<string, T> => {
    const map = new Map<string, T>();
    for (const entry of entries) {
      if (entry.paymentId === null) continue;
      map.set(entry.paymentId, entry);
    }
    return map;
  };
  const links = index(linkRows);
  const settlementTotals = index(settlementRows);
  const adjustments = index(adjustmentRows);
  const evidenceCounts = index(evidenceRows);

  return rows.map((row) => ({
    id: row.id as PaymentId,
    accountId: row.accountId as AccountId,
    accountName: row.accountName,
    importBatchId: row.importBatchId as ImportBatchId,
    amount: row.amount as Paise,
    currency: row.currency,
    direction: row.direction as PaymentDirection,
    occurredAt: row.occurredAt,
    rawDescription: row.rawDescription,
    channel: row.channel,
    counterpartyType: row.counterpartyType as PaymentCounterpartyType,
    counterpartyId: row.counterpartyId,
    counterpartyName: row.merchantName ?? row.personName,
    externalReference: row.externalReference,
    referenceType: row.referenceType,
    sourceSystem: row.sourceSystem,
    state: row.state as PaymentState,
    ignoredReason: row.ignoredReason,
    cashFlowCategory: row.cashFlowCategory as CashFlowCategory | null,
    cashFlowState: row.cashFlowState as CashFlowState,
    cashFlowApprovedAt: row.cashFlowApprovedAt,
    cashFlowApprovedBy: row.cashFlowApprovedBy,
    expenseLinkTotal: BigInt(links.get(row.id)?.total ?? '0') as Paise,
    settlementTotal: BigInt(settlementTotals.get(row.id)?.total ?? '0') as Paise,
    adjustmentTotal: BigInt(adjustments.get(row.id)?.total ?? '0') as Paise,
    evidenceCount: Number(evidenceCounts.get(row.id)?.count ?? 0),
    expenseLinkCount: Number(links.get(row.id)?.count ?? 0),
    settlementCount: Number(settlementTotals.get(row.id)?.count ?? 0),
  }));
}

/** One payment, in the same shape the list returns, for a detail screen. */
export async function getPaymentWorkspaceRow(
  exec: Executor,
  paymentId: PaymentId,
): Promise<PaymentWorkspaceRow | null> {
  const [row] = await listPaymentsForWorkspace(exec, { paymentId, limit: 1 });
  return row ?? null;
}

/**
 * The people and merchants a payment's counterparty may be set to, for the workspace's
 * counterparty editor. A read; assigning one is `services.setPaymentCounterparty`.
 */
export async function listCounterpartyCandidates(exec: Executor): Promise<{
  merchants: Array<{ id: MerchantId; canonicalName: string }>;
  people: Array<{ id: PersonId; displayName: string }>;
  accounts: Array<{ id: AccountId; name: string }>;
}> {
  const [merchantRows, peopleRows, accountRows] = await Promise.all([
    exec
      .select({ id: merchants.id, canonicalName: merchants.canonicalName })
      .from(merchants)
      .orderBy(asc(merchants.canonicalName)),
    exec
      .select({ id: people.id, displayName: people.displayName })
      .from(people)
      .orderBy(asc(people.displayName)),
    exec
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .orderBy(asc(accounts.name)),
  ]);
  return {
    merchants: merchantRows.map((row) => ({ ...row, id: row.id as MerchantId })),
    people: peopleRows.map((row) => ({ ...row, id: row.id as PersonId })),
    accounts: accountRows.map((row) => ({ ...row, id: row.id as AccountId })),
  };
}
