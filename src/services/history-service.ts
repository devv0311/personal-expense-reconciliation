/**
 * Browsing what the ledger already recorded: the evidence library, the audit trail over one
 * record, and one expense's whole story from purchase to settlement.
 *
 * Closes audit rows 10 (no evidence library), 26 (no chronological adjustment log or old
 * allocation viewer) and 33 (no general audit or allocation-version history read).
 *
 * Every one of these is a **read**. Nothing here writes, and nothing here computes a figure:
 * the amounts an allocation version carries are the amounts that were written when a person
 * approved it, quoted back unchanged. Re-deriving them would answer a different question — what
 * that split *would* be today — and silently relabel it as history.
 */

import type {
  AuditableEntityType,
  EvidenceId,
  ExpenseId,
  PaymentId,
  SettlementId,
} from '../domain/index.js';
import {
  collectExpenseTimelineSources,
  countEvidenceLibrary,
  getExpenseById,
  listAllocationVersions,
  listAuditEventsForEntities,
  listEvidenceLibrary,
} from '../db/index.js';
import type {
  AllocationVersionRow,
  AuditEventRow,
  EvidenceLibraryFilter,
  EvidenceLibraryRow,
  Executor,
} from '../db/index.js';

import { ServiceError } from './errors.js';

/* ==================================================================== evidence library */

export interface EvidenceLibraryResult {
  readonly evidence: readonly EvidenceLibraryRow[];
  /** How many documents match across the whole store, not how many came back. */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/**
 * Every stored document and note, filtered.
 *
 * Deliberately returns `rawText`. This surface is local — the sanitization boundary governs
 * what leaves the machine, not what a person may read on their own screen, and an inspector
 * that redacted the bank's own SMS would defeat the reason the source is kept immutable
 * (`security-model.md`; the same line ADR-0048's evidence inspector holds).
 */
export async function listEvidenceCatalog(
  db: Executor,
  filter: EvidenceLibraryFilter = {},
): Promise<EvidenceLibraryResult> {
  const limit = filter.limit ?? 100;
  const offset = filter.offset ?? 0;
  const [evidence, total] = await Promise.all([
    listEvidenceLibrary(db, { ...filter, limit, offset }),
    countEvidenceLibrary(db, filter),
  ]);
  return { evidence, total, limit, offset };
}

/* ====================================================================== audit history */

export interface AuditHistoryResult {
  readonly events: readonly AuditEventRow[];
}

/**
 * The audit trail over one record — who changed what, when, from what, and why.
 *
 * Oldest first, ordered by the append-only log's own monotonic sequence. The trail is the
 * record's history, so a caller naming an entity that has never been written simply gets an
 * empty list: "nothing has happened to this" is an answer, not an error.
 */
export async function getAuditHistory(
  db: Executor,
  entityType: AuditableEntityType,
  entityId: string,
  options: { readonly limit?: number } = {},
): Promise<AuditHistoryResult> {
  const events = await listAuditEventsForEntities(db, [{ entityType, entityId }], options);
  return { events };
}

/* =========================================================== one expense's whole story */

export interface ExpenseHistoryResult {
  readonly expenseId: ExpenseId;
  /**
   * Every allocation this expense has had, oldest first, each with the lines it was approved
   * with. The current one is the single row whose `supersededAt` is null.
   */
  readonly allocationVersions: readonly AllocationVersionRow[];
  /**
   * The audit events of the expense and everything hanging off it — allocations, adjustments,
   * attached documents — in one chronological sequence.
   */
  readonly events: readonly AuditEventRow[];
  /** What was gathered, so a surface can say plainly what the timeline does and does not cover. */
  readonly sources: {
    readonly allocationIds: readonly string[];
    readonly adjustmentIds: readonly string[];
    readonly evidenceIds: readonly EvidenceId[];
    readonly settlementIds: readonly SettlementId[];
  };
}

/**
 * One expense's complete story: purchase → refund events → allocation versions → settlements
 * (audit row 26).
 *
 * The settlements included are the payer's, not "this expense's" — a `Settlement` discharges a
 * balance between two people and never one particular expense (ADR-0007). Saying otherwise on
 * a timeline would be inventing a link the ledger deliberately does not model.
 */
export async function getExpenseHistory(
  db: Executor,
  expenseId: ExpenseId,
): Promise<ExpenseHistoryResult> {
  const expense = await getExpenseById(db, expenseId);
  if (expense === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', 'No such expense.', { expenseId });
  }

  const sources = await collectExpenseTimelineSources(db, expenseId);
  const entities: Array<{ entityType: AuditableEntityType; entityId: string }> = [
    { entityType: 'expense', entityId: expenseId },
    ...sources.allocationIds.map((id) => ({ entityType: 'allocation' as const, entityId: id })),
    ...sources.adjustmentIds.map((id) => ({
      entityType: 'expense_adjustment' as const,
      entityId: id,
    })),
    ...sources.evidenceIds.map((id) => ({ entityType: 'evidence' as const, entityId: id })),
    ...sources.settlementIds.map((id) => ({ entityType: 'settlement' as const, entityId: id })),
  ];

  const [allocationVersions, events] = await Promise.all([
    listAllocationVersions(db, expenseId),
    listAuditEventsForEntities(db, entities),
  ]);

  return {
    expenseId,
    allocationVersions,
    events,
    sources: {
      allocationIds: sources.allocationIds,
      adjustmentIds: sources.adjustmentIds,
      evidenceIds: sources.evidenceIds as readonly EvidenceId[],
      settlementIds: sources.settlementIds as readonly SettlementId[],
    },
  };
}

/* ============================================================== one payment's history */

/** The audit trail over one payment — every classification, decision and correction on it. */
export async function getPaymentHistory(
  db: Executor,
  paymentId: PaymentId,
): Promise<AuditHistoryResult> {
  return getAuditHistory(db, 'payment', paymentId);
}
