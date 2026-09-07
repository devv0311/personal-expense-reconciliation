/**
 * The two reads a history surface needs and no earlier phase had: an evidence library, and the
 * audit trail over one record.
 *
 * Audit rows 10 and 33 named them. Row 10: *"There is no evidence library/list endpoint and
 * screen for browsing all stored documents."* Row 33: *"The backend audit trail is
 * substantially broader than the website … no general `AuditEvent` or allocation-version
 * history API."* Both were already recorded faithfully; neither could be looked at.
 *
 * Reads only. `audit_events` is append-only and stays that way — nothing here writes, and
 * there is deliberately no update or delete counterpart anywhere in `src/db`
 * (`invariants.md` #22).
 */

import { and, asc, desc, eq, gte, inArray, isNull, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import type {
  AuditableEntityType,
  EvidenceMediaType,
  EvidenceNoteKind,
  EvidenceType,
} from '../domain/enums.js';
import type { EvidenceId, ExpenseId, PaymentId } from '../domain/ids.js';

import type { Executor } from './repositories.js';
import {
  allocationLines,
  allocations,
  auditEvents,
  evidence,
  evidenceObservations,
  expenseAdjustments,
  expenses,
  people,
  receipts,
  settlements,
} from './schema.js';

/* ==================================================================== evidence library */

export interface EvidenceLibraryFilter {
  readonly type?: EvidenceType;
  readonly noteKind?: EvidenceNoteKind;
  /** `'linked'` — attached to something; `'unlinked'` — attached to nothing yet. */
  readonly linkage?: 'linked' | 'unlinked';
  readonly linkedPaymentId?: PaymentId;
  readonly linkedExpenseId?: ExpenseId;
  /** Case-insensitive substring of the raw text a note or notification carries. */
  readonly search?: string;
  readonly capturedFrom?: Date;
  /** Exclusive. */
  readonly capturedTo?: Date;
  readonly limit?: number;
  readonly offset?: number;
}

export interface EvidenceLibraryRow {
  readonly id: EvidenceId;
  readonly type: EvidenceType;
  readonly noteKind: EvidenceNoteKind | null;
  readonly storageRef: string | null;
  readonly mediaType: EvidenceMediaType | null;
  readonly byteSize: number | null;
  /**
   * The document's own words, verbatim.
   *
   * This surface is local-only, which is what makes returning it correct: the sanitization
   * boundary is about what leaves the machine, and an inspector showing a bank SMS as the bank
   * wrote it is the whole point of keeping the source immutable (`security-model.md`, and
   * ADR-0048's evidence inspector).
   */
  readonly rawText: string | null;
  readonly capturedAt: Date;
  readonly createdAt: Date;
  readonly linkedPaymentId: PaymentId | null;
  readonly linkedExpenseId: ExpenseId | null;
  /** Whether a `Receipt` was extracted from this document — a count, not the extraction. */
  readonly hasReceipt: boolean;
  readonly hasObservation: boolean;
}

function evidenceConditions(filter: EvidenceLibraryFilter): SQL[] {
  const conditions: SQL[] = [];
  if (filter.type !== undefined) conditions.push(eq(evidence.type, filter.type));
  if (filter.noteKind !== undefined) conditions.push(eq(evidence.noteKind, filter.noteKind));
  if (filter.linkedPaymentId !== undefined) {
    conditions.push(eq(evidence.linkedPaymentId, filter.linkedPaymentId));
  }
  if (filter.linkedExpenseId !== undefined) {
    conditions.push(eq(evidence.linkedExpenseId, filter.linkedExpenseId));
  }
  if (filter.linkage === 'unlinked') {
    conditions.push(and(isNull(evidence.linkedPaymentId), isNull(evidence.linkedExpenseId))!);
  }
  if (filter.linkage === 'linked') {
    conditions.push(or(isNotNull(evidence.linkedPaymentId), isNotNull(evidence.linkedExpenseId))!);
  }
  if (filter.capturedFrom !== undefined) {
    conditions.push(gte(evidence.capturedAt, filter.capturedFrom));
  }
  if (filter.capturedTo !== undefined) conditions.push(lt(evidence.capturedAt, filter.capturedTo));
  if (filter.search !== undefined && filter.search.trim().length > 0) {
    conditions.push(sql`${evidence.rawText} ilike ${`%${filter.search.trim()}%`}`);
  }
  return conditions;
}

/** Every stored document and note, newest capture first. */
export async function listEvidenceLibrary(
  exec: Executor,
  filter: EvidenceLibraryFilter = {},
): Promise<EvidenceLibraryRow[]> {
  const conditions = evidenceConditions(filter);
  const base = exec
    .select({
      id: evidence.id,
      type: evidence.type,
      noteKind: evidence.noteKind,
      storageRef: evidence.storageRef,
      mediaType: evidence.mediaType,
      byteSize: evidence.byteSize,
      rawText: evidence.rawText,
      capturedAt: evidence.capturedAt,
      createdAt: evidence.createdAt,
      linkedPaymentId: evidence.linkedPaymentId,
      linkedExpenseId: evidence.linkedExpenseId,
    })
    .from(evidence);

  const rows = await (conditions.length === 0 ? base : base.where(and(...conditions)))
    .orderBy(desc(evidence.capturedAt), asc(evidence.id))
    .limit(filter.limit ?? 100)
    .offset(filter.offset ?? 0);
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [receiptRows, observationRows] = await Promise.all([
    exec
      .select({ evidenceId: receipts.evidenceId })
      .from(receipts)
      .where(inArray(receipts.evidenceId, ids)),
    exec
      .select({ evidenceId: evidenceObservations.evidenceId })
      .from(evidenceObservations)
      .where(inArray(evidenceObservations.evidenceId, ids)),
  ]);
  const withReceipt = new Set(receiptRows.map((row) => row.evidenceId));
  const withObservation = new Set(observationRows.map((row) => row.evidenceId));

  return rows.map((row) => ({
    id: row.id as EvidenceId,
    type: row.type as EvidenceType,
    noteKind: row.noteKind as EvidenceNoteKind | null,
    storageRef: row.storageRef,
    mediaType: row.mediaType as EvidenceMediaType | null,
    byteSize: row.byteSize,
    rawText: row.rawText,
    capturedAt: row.capturedAt,
    createdAt: row.createdAt,
    linkedPaymentId: row.linkedPaymentId as PaymentId | null,
    linkedExpenseId: row.linkedExpenseId as ExpenseId | null,
    hasReceipt: withReceipt.has(row.id),
    hasObservation: withObservation.has(row.id),
  }));
}

export async function countEvidenceLibrary(
  exec: Executor,
  filter: EvidenceLibraryFilter = {},
): Promise<number> {
  const conditions = evidenceConditions(filter);
  const query = exec.select({ total: sql<number>`count(*)::int` }).from(evidence);
  const [row] = await (conditions.length === 0 ? query : query.where(and(...conditions)));
  return Number(row?.total ?? 0);
}

/* ====================================================================== audit history */

export interface AuditEventRow {
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
  readonly actor: string;
  readonly source: string | null;
  readonly reason: string | null;
  readonly occurredAt: Date;
  readonly sequence: string;
}

/**
 * Every audit event over a set of entities, oldest first.
 *
 * Ordered by the monotonic `sequence`, never `occurred_at`: that column resolves to
 * milliseconds, so events written back-to-back inside one audited unit of work tie, and the
 * order would fall through to a random UUID. An append-only log whose order is arbitrary
 * cannot answer "what happened, and then what happened next".
 */
export async function listAuditEventsForEntities(
  exec: Executor,
  entities: ReadonlyArray<{ readonly entityType: AuditableEntityType; readonly entityId: string }>,
  options: { readonly limit?: number } = {},
): Promise<AuditEventRow[]> {
  if (entities.length === 0) return [];
  const clauses = entities.map((entity) =>
    and(eq(auditEvents.entityType, entity.entityType), eq(auditEvents.entityId, entity.entityId)),
  );
  const rows = await exec
    .select({
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      action: auditEvents.action,
      oldValue: auditEvents.oldValue,
      newValue: auditEvents.newValue,
      actor: auditEvents.actor,
      source: auditEvents.source,
      reason: auditEvents.reason,
      occurredAt: auditEvents.occurredAt,
      sequence: auditEvents.sequence,
    })
    .from(auditEvents)
    .where(or(...clauses))
    .orderBy(asc(auditEvents.sequence))
    .limit(options.limit ?? 500);
  return rows.map((row) => ({ ...row, sequence: String(row.sequence) }));
}

/* ============================================================ one expense's whole story */

export interface AllocationVersionRow {
  readonly allocationId: string;
  readonly method: string;
  readonly decidedAt: Date;
  readonly decidedBy: string;
  readonly supersededAt: Date | null;
  readonly lines: ReadonlyArray<{
    readonly beneficiaryType: string;
    readonly beneficiaryId: string;
    readonly beneficiaryName: string | null;
    readonly amount: string;
    readonly expenseItemId: string | null;
  }>;
}

/**
 * Every allocation an expense has ever had, oldest first, with its lines (audit row 26).
 *
 * Superseded versions are the point: *"complete purchase→refund-event→allocation-version→
 * settlement history is not inspectable on one website screen."* A superseded allocation is
 * kept forever precisely so that question stays answerable, and this is the read that asks it.
 */
export async function listAllocationVersions(
  exec: Executor,
  expenseId: ExpenseId,
): Promise<AllocationVersionRow[]> {
  const versions = await exec
    .select({
      allocationId: allocations.id,
      method: allocations.method,
      decidedAt: allocations.decidedAt,
      decidedBy: allocations.decidedBy,
      supersededAt: allocations.supersededAt,
    })
    .from(allocations)
    .where(eq(allocations.expenseId, expenseId))
    .orderBy(asc(allocations.decidedAt), asc(allocations.id));
  if (versions.length === 0) return [];

  const lineRows = await exec
    .select({
      allocationId: allocationLines.allocationId,
      beneficiaryType: allocationLines.beneficiaryType,
      beneficiaryId: allocationLines.beneficiaryId,
      beneficiaryName: people.displayName,
      amount: allocationLines.amount,
      expenseItemId: allocationLines.expenseItemId,
    })
    .from(allocationLines)
    .leftJoin(
      people,
      and(
        eq(allocationLines.beneficiaryType, 'person'),
        eq(people.id, allocationLines.beneficiaryId),
      ),
    )
    .where(
      inArray(
        allocationLines.allocationId,
        versions.map((version) => version.allocationId),
      ),
    )
    .orderBy(asc(allocationLines.beneficiaryId));

  return versions.map((version) => ({
    ...version,
    lines: lineRows
      .filter((line) => line.allocationId === version.allocationId)
      .map((line) => ({
        beneficiaryType: line.beneficiaryType,
        beneficiaryId: line.beneficiaryId,
        beneficiaryName: line.beneficiaryName,
        amount: String(line.amount),
        expenseItemId: line.expenseItemId,
      })),
  }));
}

export interface ExpenseTimelineSources {
  readonly expenseId: ExpenseId;
  readonly allocationIds: readonly string[];
  readonly adjustmentIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly settlementIds: readonly string[];
}

/**
 * The ids whose audit events together make up one expense's story.
 *
 * Gathered here rather than in the service so the service can hand `listAuditEventsForEntities`
 * one list: the expense itself, every allocation version, every adjustment, every attached
 * document, and every settlement between the payer and a beneficiary of it.
 */
export async function collectExpenseTimelineSources(
  exec: Executor,
  expenseId: ExpenseId,
): Promise<ExpenseTimelineSources> {
  const [allocationRows, adjustmentRows, evidenceRows, expenseRow] = await Promise.all([
    exec
      .select({ id: allocations.id })
      .from(allocations)
      .where(eq(allocations.expenseId, expenseId)),
    exec
      .select({ id: expenseAdjustments.id })
      .from(expenseAdjustments)
      .where(eq(expenseAdjustments.originalExpenseId, expenseId)),
    exec.select({ id: evidence.id }).from(evidence).where(eq(evidence.linkedExpenseId, expenseId)),
    exec
      .select({ paidByPersonId: expenses.paidByPersonId })
      .from(expenses)
      .where(eq(expenses.id, expenseId)),
  ]);

  // Settlements are between people, not against an expense — so the ones worth showing here
  // are the payer's, which is what a reader means by "and then they paid me back". Naming
  // them as *this expense's* settlements would be a claim the ledger cannot make: a
  // settlement discharges a balance, never one particular expense (ADR-0007).
  const payerId = expenseRow[0]?.paidByPersonId;
  const settlementRows =
    payerId === undefined
      ? []
      : await exec
          .select({ id: settlements.id })
          .from(settlements)
          .where(eq(settlements.counterpartyPersonId, payerId));

  return {
    expenseId,
    allocationIds: allocationRows.map((row) => row.id),
    adjustmentIds: adjustmentRows.map((row) => row.id),
    evidenceIds: evidenceRows.map((row) => row.id),
    settlementIds: settlementRows.map((row) => row.id),
  };
}
