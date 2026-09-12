/**
 * Persistence for Splitwise remote-to-local change discovery (ADR-0056).
 *
 * Its own module rather than more of `repositories.ts`, for the reason every other split here
 * had: these rows are one capability's, and a reader looking for "what does discovery write"
 * should find it in one file.
 *
 * The shape mirrors `splitwise_audit_findings` deliberately — insert, observe, supersede, link
 * a successor, record a decision — because the idempotency contract is the same one, and two
 * different spellings of it would be two things to keep in agreement.
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import type {
  ExpenseId,
  ExternalIntegrationId,
  Paise,
  PaymentDirection,
  PersonId,
  SettlementId,
  SplitwiseExpenseId,
  SplitwiseExpenseSyncStatus,
  SplitwiseExternalReadStatus,
  SplitwiseRemoteChangeEffect,
  SplitwiseRemoteChangeId,
  SplitwiseRemoteChangeKind,
  SplitwiseRemoteChangeStatus,
  SplitwiseRemoteReadId,
  SplitwiseSettlementId,
  SplitwiseSettlementSyncStatus,
} from '../domain/index.js';

import type { Executor } from './repositories.js';
import {
  payments,
  settlements,
  splitwiseExpenses,
  splitwiseRemoteChanges,
  splitwiseRemoteReads,
  splitwiseSettlements,
} from './schema.js';

/* ============================================================================== the run */

export interface SplitwiseRemoteReadDraft {
  readonly externalIntegrationId: ExternalIntegrationId | null;
  readonly externalReadStatus: SplitwiseExternalReadStatus;
  readonly externalReadDetail: string | null;
  readonly pairsRead: number;
  readonly pairsUnchecked: number;
}

export interface SplitwiseRemoteReadRow extends SplitwiseRemoteReadDraft {
  readonly id: SplitwiseRemoteReadId;
  readonly runAt: Date;
  readonly changesCreated: number;
  readonly changesReobserved: number;
  readonly changesSuperseded: number;
}

export async function insertSplitwiseRemoteRead(
  exec: Executor,
  draft: SplitwiseRemoteReadDraft,
): Promise<SplitwiseRemoteReadId> {
  const [row] = await exec
    .insert(splitwiseRemoteReads)
    .values({
      externalIntegrationId: draft.externalIntegrationId,
      externalReadStatus: draft.externalReadStatus,
      externalReadDetail: draft.externalReadDetail,
      pairsRead: draft.pairsRead,
      pairsUnchecked: draft.pairsUnchecked,
    })
    .returning({ id: splitwiseRemoteReads.id });
  if (row === undefined) throw new Error('insert into splitwise_remote_reads returned no row');
  return row.id as SplitwiseRemoteReadId;
}

/**
 * Writes the tallies once the run's changes have been reconciled.
 *
 * Not part of the insert, for the same reason the audit's counts are not: they are not known
 * until every pair has been compared, and a row claiming them up front would be describing
 * work it had not done.
 */
export async function updateSplitwiseRemoteReadCounts(
  exec: Executor,
  remoteReadId: SplitwiseRemoteReadId,
  counts: {
    readonly changesCreated: number;
    readonly changesReobserved: number;
    readonly changesSuperseded: number;
  },
): Promise<void> {
  await exec
    .update(splitwiseRemoteReads)
    .set({
      changesCreated: counts.changesCreated,
      changesReobserved: counts.changesReobserved,
      changesSuperseded: counts.changesSuperseded,
    })
    .where(eq(splitwiseRemoteReads.id, remoteReadId));
}

export async function getSplitwiseRemoteReadById(
  exec: Executor,
  remoteReadId: SplitwiseRemoteReadId,
): Promise<SplitwiseRemoteReadRow | null> {
  const [row] = await exec
    .select()
    .from(splitwiseRemoteReads)
    .where(eq(splitwiseRemoteReads.id, remoteReadId));
  return row === undefined ? null : toRemoteReadRow(row);
}

/** Discovery history, newest first. */
export async function listSplitwiseRemoteReads(
  exec: Executor,
  options: { readonly limit?: number } = {},
): Promise<SplitwiseRemoteReadRow[]> {
  const rows = await exec
    .select()
    .from(splitwiseRemoteReads)
    .orderBy(desc(splitwiseRemoteReads.runAt), desc(splitwiseRemoteReads.id))
    .limit(options.limit ?? 50);
  return rows.map(toRemoteReadRow);
}

/* =========================================================================== the changes */

export interface SplitwiseRemoteChangeDraftRow {
  readonly remoteReadId: SplitwiseRemoteReadId;
  readonly externalIntegrationId: ExternalIntegrationId;
  readonly kind: SplitwiseRemoteChangeKind;
  readonly effect: SplitwiseRemoteChangeEffect;
  readonly summary: string;
  readonly consequence: string;
  readonly readStatus: SplitwiseExternalReadStatus;
  readonly readDetail: string | null;
  readonly personAId: PersonId | null;
  readonly personBId: PersonId | null;
  readonly expenseId: ExpenseId | null;
  readonly splitwiseExpenseRowId: SplitwiseExpenseId | null;
  readonly settlementId: SettlementId | null;
  readonly splitwiseSettlementRowId: SplitwiseSettlementId | null;
  readonly externalReference: string | null;
  readonly externalUserReference: string | null;
  readonly amount: Paise | null;
  readonly localSnapshot: unknown;
  readonly remoteSnapshot: unknown;
  readonly subjects: unknown;
  readonly fingerprint: string;
  readonly comparisonDigest: string;
}

export interface SplitwiseRemoteChangeRow extends SplitwiseRemoteChangeDraftRow {
  readonly id: SplitwiseRemoteChangeId;
  readonly lastObservedReadId: SplitwiseRemoteReadId;
  readonly firstObservedAt: Date;
  readonly lastObservedAt: Date;
  readonly status: SplitwiseRemoteChangeStatus;
  readonly decidedAt: Date | null;
  readonly decidedBy: string | null;
  readonly decisionReason: string | null;
  readonly appliedEffect: SplitwiseRemoteChangeEffect | null;
  readonly appliedTargetId: string | null;
  readonly supersededAt: Date | null;
  readonly supersededByChangeId: SplitwiseRemoteChangeId | null;
}

export async function insertSplitwiseRemoteChange(
  exec: Executor,
  draft: SplitwiseRemoteChangeDraftRow,
): Promise<SplitwiseRemoteChangeId> {
  const [row] = await exec
    .insert(splitwiseRemoteChanges)
    .values({
      remoteReadId: draft.remoteReadId,
      lastObservedReadId: draft.remoteReadId,
      externalIntegrationId: draft.externalIntegrationId,
      kind: draft.kind,
      effect: draft.effect,
      summary: draft.summary,
      consequence: draft.consequence,
      readStatus: draft.readStatus,
      readDetail: draft.readDetail,
      personAId: draft.personAId,
      personBId: draft.personBId,
      expenseId: draft.expenseId,
      splitwiseExpenseRowId: draft.splitwiseExpenseRowId,
      settlementId: draft.settlementId,
      splitwiseSettlementRowId: draft.splitwiseSettlementRowId,
      externalReference: draft.externalReference,
      externalUserReference: draft.externalUserReference,
      amount: draft.amount,
      localSnapshot: draft.localSnapshot,
      remoteSnapshot: draft.remoteSnapshot ?? null,
      subjects: draft.subjects,
      fingerprint: draft.fingerprint,
      comparisonDigest: draft.comparisonDigest,
    })
    .returning({ id: splitwiseRemoteChanges.id });
  if (row === undefined) throw new Error('insert into splitwise_remote_changes returned no row');
  return row.id as SplitwiseRemoteChangeId;
}

/** Every change still current — the set a re-run compares itself against. */
export async function listCurrentSplitwiseRemoteChanges(
  exec: Executor,
): Promise<SplitwiseRemoteChangeRow[]> {
  const rows = await exec
    .select()
    .from(splitwiseRemoteChanges)
    .where(isNull(splitwiseRemoteChanges.supersededAt))
    .orderBy(asc(splitwiseRemoteChanges.firstObservedAt), asc(splitwiseRemoteChanges.id));
  return rows.map(toRemoteChangeRow);
}

export interface ListSplitwiseRemoteChangesFilter {
  readonly status?: SplitwiseRemoteChangeStatus;
  readonly kind?: SplitwiseRemoteChangeKind;
  readonly personId?: PersonId;
  readonly remoteReadId?: SplitwiseRemoteReadId;
  /** Superseded rows are history and are excluded unless a caller asks for them. */
  readonly includeSuperseded?: boolean;
  readonly limit?: number;
}

export async function listSplitwiseRemoteChanges(
  exec: Executor,
  filter: ListSplitwiseRemoteChangesFilter = {},
): Promise<SplitwiseRemoteChangeRow[]> {
  const conditions = [
    ...(filter.includeSuperseded === true ? [] : [isNull(splitwiseRemoteChanges.supersededAt)]),
    ...(filter.status === undefined ? [] : [eq(splitwiseRemoteChanges.status, filter.status)]),
    ...(filter.kind === undefined ? [] : [eq(splitwiseRemoteChanges.kind, filter.kind)]),
    ...(filter.remoteReadId === undefined
      ? []
      : [eq(splitwiseRemoteChanges.remoteReadId, filter.remoteReadId)]),
    ...(filter.personId === undefined
      ? []
      : [
          sql`(${splitwiseRemoteChanges.personAId} = ${filter.personId}
               or ${splitwiseRemoteChanges.personBId} = ${filter.personId})`,
        ]),
  ];

  const rows = await exec
    .select()
    .from(splitwiseRemoteChanges)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(splitwiseRemoteChanges.firstObservedAt), asc(splitwiseRemoteChanges.id))
    .limit(filter.limit ?? 100);
  return rows.map(toRemoteChangeRow);
}

export async function getSplitwiseRemoteChangeById(
  exec: Executor,
  changeId: SplitwiseRemoteChangeId,
): Promise<SplitwiseRemoteChangeRow | null> {
  const [row] = await exec
    .select()
    .from(splitwiseRemoteChanges)
    .where(eq(splitwiseRemoteChanges.id, changeId));
  return row === undefined ? null : toRemoteChangeRow(row);
}

/**
 * Records that a later run observed the identical comparison.
 *
 * Touches when-last-seen and which run saw it, and nothing else — in particular not `status`.
 * **A decided change is not reopened by re-observing the same thing** (ADR-0056): the person
 * decided about this exact remote state, and re-reading it does not unmake that.
 */
export async function markSplitwiseRemoteChangeObserved(
  exec: Executor,
  changeId: SplitwiseRemoteChangeId,
  remoteReadId: SplitwiseRemoteReadId,
): Promise<void> {
  await exec
    .update(splitwiseRemoteChanges)
    .set({ lastObservedReadId: remoteReadId, lastObservedAt: new Date(), updatedAt: new Date() })
    .where(eq(splitwiseRemoteChanges.id, changeId));
}

/**
 * Closes a change as history.
 *
 * Never a delete and never an in-place rewrite: the superseded row keeps both snapshots and
 * whatever decision was recorded on it, which is what makes "what was true then, and what did
 * somebody decide about it" answerable after the remote state has moved on again.
 */
export async function supersedeSplitwiseRemoteChange(
  exec: Executor,
  changeId: SplitwiseRemoteChangeId,
): Promise<void> {
  await exec
    .update(splitwiseRemoteChanges)
    .set({ supersededAt: new Date(), updatedAt: new Date() })
    .where(eq(splitwiseRemoteChanges.id, changeId));
}

/** Names the change that replaced a superseded one, once the successor exists. */
export async function linkSplitwiseRemoteChangeSuccessor(
  exec: Executor,
  changeId: SplitwiseRemoteChangeId,
  supersededByChangeId: SplitwiseRemoteChangeId,
): Promise<void> {
  await exec
    .update(splitwiseRemoteChanges)
    .set({ supersededByChangeId, updatedAt: new Date() })
    .where(eq(splitwiseRemoteChanges.id, changeId));
}

/** Records a person's decision. The append-only history is in `audit_events`. */
export async function updateSplitwiseRemoteChangeDecision(
  exec: Executor,
  changeId: SplitwiseRemoteChangeId,
  decision: {
    readonly status: Exclude<SplitwiseRemoteChangeStatus, 'proposed'>;
    readonly decidedAt: Date;
    readonly decidedBy: string;
    readonly decisionReason: string;
    readonly appliedEffect: SplitwiseRemoteChangeEffect | null;
    readonly appliedTargetId: string | null;
  },
): Promise<void> {
  await exec
    .update(splitwiseRemoteChanges)
    .set({
      status: decision.status,
      decidedAt: decision.decidedAt,
      decidedBy: decision.decidedBy,
      decisionReason: decision.decisionReason,
      appliedEffect: decision.appliedEffect,
      appliedTargetId: decision.appliedTargetId,
      updatedAt: new Date(),
    })
    .where(eq(splitwiseRemoteChanges.id, changeId));
}

/* ------------------------------------------------------------------------- internals */

function toRemoteReadRow(row: typeof splitwiseRemoteReads.$inferSelect): SplitwiseRemoteReadRow {
  return {
    id: row.id as SplitwiseRemoteReadId,
    runAt: row.runAt,
    externalIntegrationId: row.externalIntegrationId as ExternalIntegrationId | null,
    externalReadStatus: row.externalReadStatus as SplitwiseExternalReadStatus,
    externalReadDetail: row.externalReadDetail,
    pairsRead: row.pairsRead,
    pairsUnchecked: row.pairsUnchecked,
    changesCreated: row.changesCreated,
    changesReobserved: row.changesReobserved,
    changesSuperseded: row.changesSuperseded,
  };
}

function toRemoteChangeRow(
  row: typeof splitwiseRemoteChanges.$inferSelect,
): SplitwiseRemoteChangeRow {
  return {
    id: row.id as SplitwiseRemoteChangeId,
    remoteReadId: row.remoteReadId as SplitwiseRemoteReadId,
    lastObservedReadId: row.lastObservedReadId as SplitwiseRemoteReadId,
    externalIntegrationId: row.externalIntegrationId as ExternalIntegrationId,
    kind: row.kind as SplitwiseRemoteChangeKind,
    effect: row.effect as SplitwiseRemoteChangeEffect,
    summary: row.summary,
    consequence: row.consequence,
    readStatus: row.readStatus as SplitwiseExternalReadStatus,
    readDetail: row.readDetail,
    personAId: row.personAId as PersonId | null,
    personBId: row.personBId as PersonId | null,
    expenseId: row.expenseId as ExpenseId | null,
    splitwiseExpenseRowId: row.splitwiseExpenseRowId as SplitwiseExpenseId | null,
    settlementId: row.settlementId as SettlementId | null,
    splitwiseSettlementRowId: row.splitwiseSettlementRowId as SplitwiseSettlementId | null,
    externalReference: row.externalReference,
    externalUserReference: row.externalUserReference,
    amount: row.amount as Paise | null,
    localSnapshot: row.localSnapshot,
    remoteSnapshot: row.remoteSnapshot,
    subjects: row.subjects,
    fingerprint: row.fingerprint,
    comparisonDigest: row.comparisonDigest,
    firstObservedAt: row.firstObservedAt,
    lastObservedAt: row.lastObservedAt,
    status: row.status as SplitwiseRemoteChangeStatus,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
    decisionReason: row.decisionReason,
    appliedEffect: row.appliedEffect as SplitwiseRemoteChangeEffect | null,
    appliedTargetId: row.appliedTargetId,
    supersededAt: row.supersededAt,
    supersededByChangeId: row.supersededByChangeId as SplitwiseRemoteChangeId | null,
  };
}

/* ================================================== applying a decision to a sync row */

/**
 * Records what Splitwise now holds on an expense's sync row, and moves its status.
 *
 * Deliberately narrower than `updateSplitwiseExpenseSync`: `our_snapshot` and `synced_at`
 * describe what *this ledger pushed and when*, and accepting somebody else's edit pushed
 * nothing. Rewriting them here would lose the record of what was actually sent — which is the
 * figure every drift comparison is made against.
 */
export async function recordSplitwiseExpenseRemoteState(
  exec: Executor,
  splitwiseExpenseRowId: SplitwiseExpenseId,
  next: {
    readonly syncStatus: SplitwiseExpenseSyncStatus;
    /** Omitted for a deletion the listing inferred rather than a row Splitwise handed back. */
    readonly theirSnapshot?: unknown;
  },
): Promise<void> {
  await exec
    .update(splitwiseExpenses)
    .set({
      syncStatus: next.syncStatus,
      ...(next.theirSnapshot === undefined ? {} : { theirSnapshot: next.theirSnapshot }),
    })
    .where(eq(splitwiseExpenses.id, splitwiseExpenseRowId));
}

/** The settlement half of {@link recordSplitwiseExpenseRemoteState}. */
export async function recordSplitwiseSettlementRemoteState(
  exec: Executor,
  splitwiseSettlementRowId: SplitwiseSettlementId,
  next: {
    readonly syncStatus: SplitwiseSettlementSyncStatus;
    readonly theirSnapshot?: unknown;
  },
): Promise<void> {
  await exec
    .update(splitwiseSettlements)
    .set({
      syncStatus: next.syncStatus,
      ...(next.theirSnapshot === undefined ? {} : { theirSnapshot: next.theirSnapshot }),
    })
    .where(eq(splitwiseSettlements.id, splitwiseSettlementRowId));
}

/**
 * Whatever local expense already claims this external id, if any.
 *
 * The adoption guard. The unique index would refuse a second claim anyway; asking first is
 * what turns a constraint violation into a sentence naming the expense that already holds it.
 */
export async function findSplitwiseExpenseByExternalId(
  exec: Executor,
  externalIntegrationId: ExternalIntegrationId,
  splitwiseExpenseId: string,
): Promise<{ id: SplitwiseExpenseId; expenseId: ExpenseId } | null> {
  const [row] = await exec
    .select({ id: splitwiseExpenses.id, expenseId: splitwiseExpenses.expenseId })
    .from(splitwiseExpenses)
    .where(
      and(
        eq(splitwiseExpenses.externalIntegrationId, externalIntegrationId),
        eq(splitwiseExpenses.splitwiseExpenseId, splitwiseExpenseId),
      ),
    );
  return row === undefined
    ? null
    : { id: row.id as SplitwiseExpenseId, expenseId: row.expenseId as ExpenseId };
}

/** The settlement half of {@link findSplitwiseExpenseByExternalId}. */
export async function findSplitwiseSettlementByExternalId(
  exec: Executor,
  externalIntegrationId: ExternalIntegrationId,
  splitwiseTransactionId: string,
): Promise<{ id: SplitwiseSettlementId; settlementId: SettlementId } | null> {
  const [row] = await exec
    .select({ id: splitwiseSettlements.id, settlementId: splitwiseSettlements.settlementId })
    .from(splitwiseSettlements)
    .where(
      and(
        eq(splitwiseSettlements.externalIntegrationId, externalIntegrationId),
        eq(splitwiseSettlements.splitwiseTransactionId, splitwiseTransactionId),
      ),
    );
  return row === undefined
    ? null
    : { id: row.id as SplitwiseSettlementId, settlementId: row.settlementId as SettlementId };
}

/** Every `SplitwiseSettlement` link with its settlement's amount and direction, for a pair. */
export async function listLinkedSplitwiseSettlementsForPair(
  exec: Executor,
  counterpartyPersonId: PersonId,
): Promise<
  Array<{
    splitwiseSettlementRowId: SplitwiseSettlementId;
    settlementId: SettlementId;
    externalId: string;
    syncStatus: SplitwiseSettlementSyncStatus;
    amount: Paise;
    direction: PaymentDirection;
  }>
> {
  const rows = await exec
    .select({
      splitwiseSettlementRowId: splitwiseSettlements.id,
      settlementId: splitwiseSettlements.settlementId,
      externalId: splitwiseSettlements.splitwiseTransactionId,
      syncStatus: splitwiseSettlements.syncStatus,
      amount: settlements.amount,
      direction: payments.direction,
    })
    .from(splitwiseSettlements)
    .innerJoin(settlements, eq(splitwiseSettlements.settlementId, settlements.id))
    .innerJoin(payments, eq(settlements.paymentId, payments.id))
    .where(eq(settlements.counterpartyPersonId, counterpartyPersonId))
    .orderBy(asc(splitwiseSettlements.syncedAt), asc(splitwiseSettlements.id));
  return rows.map((row: (typeof rows)[number]) => ({
    splitwiseSettlementRowId: row.splitwiseSettlementRowId as SplitwiseSettlementId,
    settlementId: row.settlementId as SettlementId,
    externalId: row.externalId,
    syncStatus: row.syncStatus as SplitwiseSettlementSyncStatus,
    amount: row.amount as Paise,
    direction: row.direction as PaymentDirection,
  }));
}
