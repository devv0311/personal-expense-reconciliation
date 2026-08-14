/**
 * Repository-style data access.
 *
 * Persistence only — no financial arithmetic, no invariant decisions. Every function here
 * either reads rows or writes rows a `src/services` function has already validated through
 * `src/domain`. If a function in this file ever needs to know what an amount *means*, it
 * belongs in `domain` instead.
 *
 * There is deliberately **no** update path for a SOURCE-classified column: nothing here can
 * change `payments.amount/occurred_at/raw_description/account_id`, `evidence.storage_ref/
 * raw_text/captured_at`, `expenses.amount`, or any `audit_events` row
 * (`invariants.md` #4, #6, #22).
 */

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type {
  AiInferenceStatus,
  AuditAction,
  AuditableEntityType,
  EvidenceNoteKind,
  EvidenceType,
  ExpenseState,
  PaymentState,
} from '../domain/enums.js';
import type {
  AllocationId,
  AllocationLineId,
  AuditEventId,
  ExpenseId,
  ImportBatchId,
  GroupId,
  PaymentId,
  PersonId,
  ReconciliationRunId,
  SettlementId,
} from '../domain/ids.js';
import type { Paise } from '../domain/money.js';
import { netAmount } from '../domain/expense.js';
import { SETTLEMENT_CLAIM_NOTE_KIND, claimsSettlement } from '../domain/evidence.js';
import type { BalanceAllocationLine, BalanceExpense, BalanceInput } from '../domain/balance.js';
import type { GroupMembership } from '../domain/entities.js';
import type { ReconciliationTotals } from '../domain/reconciliation.js';

import type { Database } from './client.js';
import {
  allocationLineGroupExpansions,
  allocationLines,
  allocations,
  auditEvents,
  evidence,
  expenseAdjustments,
  expenseItems,
  expenses,
  groupMemberships,
  importBatches,
  paymentExpenseLinks,
  payments,
  reconciliationRuns,
  settlements,
  splitwiseExpenses,
} from './schema.js';

/** A `Database` or an open transaction — both satisfy the same query interface. */
export type Executor = Database;

/* ============================================================================== audit */

export interface AuditEventDraft {
  readonly entityType: AuditableEntityType;
  readonly entityId: string;
  readonly action: AuditAction;
  readonly oldValue: unknown;
  readonly newValue: unknown;
  readonly actor: string;
  readonly source: string | null;
  readonly reason: string | null;
}

/**
 * Appends one audit event. There is no update or delete counterpart, by design
 * (`invariants.md` #22).
 */
export async function insertAuditEvent(
  exec: Executor,
  draft: AuditEventDraft,
): Promise<AuditEventId> {
  const [row] = await exec
    .insert(auditEvents)
    .values({
      entityType: draft.entityType,
      entityId: draft.entityId,
      action: draft.action,
      oldValue: draft.oldValue ?? null,
      newValue: draft.newValue,
      actor: draft.actor,
      source: draft.source,
      reason: draft.reason,
    })
    .returning({ id: auditEvents.id });
  return requireRow(row, 'audit_events').id as AuditEventId;
}

/** Every audit event recorded against one entity, oldest first. */
export async function listAuditEvents(
  exec: Executor,
  entityType: AuditableEntityType,
  entityId: string,
): Promise<
  Array<{
    entityType: string;
    entityId: string;
    action: string;
    oldValue: unknown;
    newValue: unknown;
    actor: string;
    reason: string | null;
    occurredAt: Date;
  }>
> {
  return exec
    .select({
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      action: auditEvents.action,
      oldValue: auditEvents.oldValue,
      newValue: auditEvents.newValue,
      actor: auditEvents.actor,
      reason: auditEvents.reason,
      occurredAt: auditEvents.occurredAt,
    })
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, entityType), eq(auditEvents.entityId, entityId)))
    .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id));
}

/* ============================================================================ expenses */

export interface ExpenseRow {
  readonly id: ExpenseId;
  readonly amount: Paise;
  readonly currency: string;
  readonly occurredAt: Date;
  readonly relationshipType: string;
  readonly paidByPersonId: PersonId;
  readonly state: ExpenseState;
}

export async function getExpenseById(
  exec: Executor,
  expenseId: ExpenseId,
): Promise<ExpenseRow | null> {
  const [row] = await exec
    .select({
      id: expenses.id,
      amount: expenses.amount,
      currency: expenses.currency,
      occurredAt: expenses.occurredAt,
      relationshipType: expenses.relationshipType,
      paidByPersonId: expenses.paidByPersonId,
      state: expenses.state,
    })
    .from(expenses)
    .where(eq(expenses.id, expenseId));
  return row === undefined ? null : (row as ExpenseRow);
}

/**
 * Moves an expense to a new lifecycle state.
 *
 * `state` is the only expense column this repository can write. `amount` has no update path
 * at all — the correction mechanism is an `ExpenseAdjustment` (`invariants.md` #6).
 */
export async function updateExpenseState(
  exec: Executor,
  expenseId: ExpenseId,
  state: ExpenseState,
): Promise<void> {
  await exec
    .update(expenses)
    .set({ state, updatedAt: new Date() })
    .where(eq(expenses.id, expenseId));
}

/* ========================================================================= allocation */

export interface AllocationLineDraft {
  readonly beneficiaryType: 'person' | 'group';
  readonly beneficiaryId: string;
  readonly amount: Paise;
  readonly percentage: string | null;
  readonly expenseItemId: string | null;
  /** Present only for a `group`-typed line (ADR-0009). */
  readonly groupExpansion?: ReadonlyArray<{ readonly personId: PersonId; readonly amount: Paise }>;
}

export interface InsertAllocationInput {
  readonly expenseId: ExpenseId;
  readonly method: string;
  readonly decidedBy: string;
  readonly decidedAt: Date;
  readonly lines: readonly AllocationLineDraft[];
}

export interface InsertedAllocation {
  readonly allocationId: AllocationId;
  readonly lineIds: readonly AllocationLineId[];
}

/**
 * Writes an allocation, its lines, and any group expansions in one go.
 *
 * The caller is expected to be inside a transaction: an allocation without its lines, or a
 * group line without its expansion, is not a state this ledger should ever be observable in
 * (`invariants.md` #2b).
 */
export async function insertAllocationWithLines(
  exec: Executor,
  input: InsertAllocationInput,
): Promise<InsertedAllocation> {
  const [allocationRow] = await exec
    .insert(allocations)
    .values({
      expenseId: input.expenseId,
      method: input.method,
      decidedAt: input.decidedAt,
      decidedBy: input.decidedBy,
    })
    .returning({ id: allocations.id });
  const allocationId = requireRow(allocationRow, 'allocations').id as AllocationId;

  const lineIds: AllocationLineId[] = [];
  for (const line of input.lines) {
    const [lineRow] = await exec
      .insert(allocationLines)
      .values({
        allocationId,
        beneficiaryType: line.beneficiaryType,
        beneficiaryId: line.beneficiaryId,
        amount: line.amount,
        percentage: line.percentage,
        expenseItemId: line.expenseItemId,
      })
      .returning({ id: allocationLines.id });
    const lineId = requireRow(lineRow, 'allocation_lines').id as AllocationLineId;
    lineIds.push(lineId);

    if (line.groupExpansion !== undefined && line.groupExpansion.length > 0) {
      await exec.insert(allocationLineGroupExpansions).values(
        line.groupExpansion.map((row) => ({
          allocationLineId: lineId,
          personId: row.personId,
          amount: row.amount,
        })),
      );
    }
  }

  return { allocationId, lineIds };
}

/**
 * Stamps `superseded_at` on the current allocation.
 *
 * The row itself is never deleted or edited otherwise — allocation versions are append-only
 * so "what did we previously believe" stays answerable (`invariants.md` #6).
 */
export async function supersedeAllocation(
  exec: Executor,
  allocationId: AllocationId,
  supersededAt: Date,
): Promise<void> {
  await exec.update(allocations).set({ supersededAt }).where(eq(allocations.id, allocationId));
}

export interface CurrentAllocationRow {
  readonly id: AllocationId;
  readonly method: string;
  readonly decidedAt: Date;
  readonly decidedBy: string;
}

/** The one allocation with no `superseded_at`, if any. */
export async function getCurrentAllocation(
  exec: Executor,
  expenseId: ExpenseId,
): Promise<CurrentAllocationRow | null> {
  const [row] = await exec
    .select({
      id: allocations.id,
      method: allocations.method,
      decidedAt: allocations.decidedAt,
      decidedBy: allocations.decidedBy,
    })
    .from(allocations)
    .where(and(eq(allocations.expenseId, expenseId), isNull(allocations.supersededAt)));
  return row === undefined ? null : (row as CurrentAllocationRow);
}

export interface AllocationLineRow {
  readonly id: AllocationLineId;
  readonly beneficiaryType: 'person' | 'group';
  readonly beneficiaryId: string;
  readonly amount: Paise;
  readonly percentage: string | null;
  readonly expenseItemId: string | null;
}

export async function listAllocationLines(
  exec: Executor,
  allocationId: AllocationId,
): Promise<AllocationLineRow[]> {
  const rows = await exec
    .select({
      id: allocationLines.id,
      beneficiaryType: allocationLines.beneficiaryType,
      beneficiaryId: allocationLines.beneficiaryId,
      amount: allocationLines.amount,
      percentage: allocationLines.percentage,
      expenseItemId: allocationLines.expenseItemId,
    })
    .from(allocationLines)
    .where(eq(allocationLines.allocationId, allocationId))
    .orderBy(asc(allocationLines.beneficiaryId), asc(allocationLines.id));
  return rows as AllocationLineRow[];
}

export async function listGroupExpansions(
  exec: Executor,
  allocationLineIds: readonly AllocationLineId[],
): Promise<Array<{ allocationLineId: AllocationLineId; personId: PersonId; amount: Paise }>> {
  if (allocationLineIds.length === 0) return [];
  const rows = await exec
    .select({
      allocationLineId: allocationLineGroupExpansions.allocationLineId,
      personId: allocationLineGroupExpansions.personId,
      amount: allocationLineGroupExpansions.amount,
    })
    .from(allocationLineGroupExpansions)
    .where(inArray(allocationLineGroupExpansions.allocationLineId, [...allocationLineIds]))
    .orderBy(asc(allocationLineGroupExpansions.personId));
  return rows as Array<{ allocationLineId: AllocationLineId; personId: PersonId; amount: Paise }>;
}

/* ======================================================================== settlements */

export interface SettlementDraft {
  readonly paymentId: PaymentId;
  readonly counterpartyPersonId: PersonId;
  readonly amount: Paise;
  readonly reason: string | null;
}

export async function insertSettlement(
  exec: Executor,
  draft: SettlementDraft,
): Promise<SettlementId> {
  const [row] = await exec
    .insert(settlements)
    .values({
      paymentId: draft.paymentId,
      counterpartyPersonId: draft.counterpartyPersonId,
      amount: draft.amount,
      reason: draft.reason,
    })
    .returning({ id: settlements.id });
  return requireRow(row, 'settlements').id as SettlementId;
}

/** Every settlement drawing on one payment — used for the payment-explanation budget. */
export async function listSettlementsByPayment(
  exec: Executor,
  paymentId: PaymentId,
): Promise<Array<{ amount: Paise }>> {
  const rows = await exec
    .select({ amount: settlements.amount })
    .from(settlements)
    .where(eq(settlements.paymentId, paymentId));
  return rows as Array<{ amount: Paise }>;
}

export async function listPaymentExpenseLinksByPayment(
  exec: Executor,
  paymentId: PaymentId,
): Promise<Array<{ amount: Paise }>> {
  const rows = await exec
    .select({ amount: paymentExpenseLinks.amount })
    .from(paymentExpenseLinks)
    .where(eq(paymentExpenseLinks.paymentId, paymentId));
  return rows as Array<{ amount: Paise }>;
}

/* ======================================================================== adjustments */

export interface ExpenseAdjustmentDraft {
  readonly originalExpenseId: ExpenseId;
  readonly kind: 'merchant_refund' | 'third_party_reimbursement';
  readonly amount: Paise;
  readonly adjustmentPaymentId: PaymentId | null;
  readonly reason: string | null;
  readonly occurredAt: Date;
}

export async function insertExpenseAdjustment(
  exec: Executor,
  draft: ExpenseAdjustmentDraft,
): Promise<string> {
  const [row] = await exec
    .insert(expenseAdjustments)
    .values({
      originalExpenseId: draft.originalExpenseId,
      kind: draft.kind,
      amount: draft.amount,
      adjustmentPaymentId: draft.adjustmentPaymentId,
      reason: draft.reason,
      occurredAt: draft.occurredAt,
    })
    .returning({ id: expenseAdjustments.id });
  return requireRow(row, 'expense_adjustments').id;
}

export async function listAdjustmentAmounts(
  exec: Executor,
  expenseId: ExpenseId,
): Promise<Paise[]> {
  const rows = await exec
    .select({ amount: expenseAdjustments.amount })
    .from(expenseAdjustments)
    .where(eq(expenseAdjustments.originalExpenseId, expenseId))
    .orderBy(asc(expenseAdjustments.occurredAt), asc(expenseAdjustments.id));
  return rows.map((row) => row.amount as Paise);
}

/* ========================================================================== payments */

export interface PaymentRow {
  readonly id: PaymentId;
  readonly amount: Paise;
  readonly direction: 'debit' | 'credit';
  readonly counterpartyType: string;
  readonly state: PaymentState;
  readonly occurredAt: Date;
  readonly externalReference: string | null;
  readonly accountId: string;
}

export async function getPaymentById(
  exec: Executor,
  paymentId: PaymentId,
): Promise<PaymentRow | null> {
  const [row] = await exec
    .select({
      id: payments.id,
      amount: payments.amount,
      direction: payments.direction,
      counterpartyType: payments.counterpartyType,
      state: payments.state,
      occurredAt: payments.occurredAt,
      externalReference: payments.externalReference,
      accountId: payments.accountId,
    })
    .from(payments)
    .where(eq(payments.id, paymentId));
  return row === undefined ? null : (row as PaymentRow);
}

/**
 * Candidate duplicates by external reference, across **all** accounts.
 *
 * Deliberately not scoped by `account_id`: one real transaction lands under two different
 * `Account` rows when a bank CSV and a UPI export both capture it (ADR-0010's amendment).
 */
export async function findPaymentsByExternalReference(
  exec: Executor,
  externalReference: string,
): Promise<PaymentRow[]> {
  const rows = await exec
    .select({
      id: payments.id,
      amount: payments.amount,
      direction: payments.direction,
      counterpartyType: payments.counterpartyType,
      state: payments.state,
      occurredAt: payments.occurredAt,
      externalReference: payments.externalReference,
      accountId: payments.accountId,
    })
    .from(payments)
    .where(eq(payments.externalReference, externalReference))
    .orderBy(asc(payments.occurredAt), asc(payments.id));
  return rows as PaymentRow[];
}

/* ==================================================================== import batches */

export interface ImportBatchDraft {
  readonly sourceChannel: string;
  readonly fileReference: string | null;
  /** Content hash, so re-importing the identical file is detectable. */
  readonly contentHash: string | null;
  readonly parserVersion: string | null;
  readonly rowCount: number;
}

export async function insertImportBatch(
  exec: Executor,
  draft: ImportBatchDraft,
): Promise<ImportBatchId> {
  const [row] = await exec
    .insert(importBatches)
    .values({
      sourceChannel: draft.sourceChannel,
      fileReference: draft.fileReference,
      contentHash: draft.contentHash,
      parserVersion: draft.parserVersion,
      rowCount: draft.rowCount,
    })
    .returning({ id: importBatches.id });
  return requireRow(row, 'import_batches').id as ImportBatchId;
}

/** Finds a previous import of byte-identical content, if there was one. */
export async function findImportBatchByContentHash(
  exec: Executor,
  contentHash: string,
): Promise<{ id: ImportBatchId; importedAt: Date } | null> {
  const [row] = await exec
    .select({ id: importBatches.id, importedAt: importBatches.importedAt })
    .from(importBatches)
    .where(eq(importBatches.contentHash, contentHash));
  return row === undefined ? null : { id: row.id as ImportBatchId, importedAt: row.importedAt };
}

/**
 * Inserts one SOURCE payment exactly as the import read it.
 *
 * Deliberately takes no `counterpartyType`/`counterpartyId`: deciding what a payment *is*
 * belongs to classification, not to ingestion, and the column keeps its `unknown` default
 * until then (`lifecycle.md`, `data-flow.md` steps 2-3).
 */
export interface PaymentDraft {
  readonly accountId: string;
  readonly importBatchId: ImportBatchId;
  readonly amount: Paise;
  readonly currency: string;
  readonly direction: 'debit' | 'credit';
  readonly occurredAt: Date;
  readonly rawDescription: string;
  readonly channel: string;
  readonly externalReference: string | null;
  readonly referenceType: string | null;
  readonly sourceSystem: string;
}

export async function insertPayment(exec: Executor, draft: PaymentDraft): Promise<PaymentId> {
  const [row] = await exec
    .insert(payments)
    .values({
      accountId: draft.accountId,
      importBatchId: draft.importBatchId,
      amount: draft.amount,
      currency: draft.currency,
      direction: draft.direction,
      occurredAt: draft.occurredAt,
      rawDescription: draft.rawDescription,
      channel: draft.channel,
      externalReference: draft.externalReference,
      referenceType: draft.referenceType,
      sourceSystem: draft.sourceSystem,
      state: 'imported',
    })
    .returning({ id: payments.id });
  return requireRow(row, 'payments').id as PaymentId;
}

/** `state` and `ignored_reason` are DERIVED metadata layered on immutable SOURCE columns. */
export async function updatePaymentState(
  exec: Executor,
  paymentId: PaymentId,
  state: PaymentState,
  ignoredReason: string | null = null,
): Promise<void> {
  await exec.update(payments).set({ state, ignoredReason }).where(eq(payments.id, paymentId));
}

/* ==================================================================== group membership */

export async function listGroupMemberships(
  exec: Executor,
  groupId?: GroupId,
): Promise<GroupMembership[]> {
  const query = exec
    .select({
      id: groupMemberships.id,
      groupId: groupMemberships.groupId,
      personId: groupMemberships.personId,
      joinedAt: groupMemberships.joinedAt,
      leftAt: groupMemberships.leftAt,
    })
    .from(groupMemberships);
  const rows =
    groupId === undefined
      ? await query.orderBy(asc(groupMemberships.personId))
      : await query
          .where(eq(groupMemberships.groupId, groupId))
          .orderBy(asc(groupMemberships.personId));
  return rows as unknown as GroupMembership[];
}

/* ============================================================================ balance */

/**
 * Loads everything `domain.computeBalance` needs: every expense with a **current**
 * allocation, that allocation's lines, and each group line's expansion rows.
 *
 * A superseded allocation is excluded here rather than filtered in the domain, so the pure
 * function can never accidentally be handed two competing versions of one expense's split.
 */
export async function loadBalanceInput(
  exec: Executor,
  userPersonId: PersonId,
): Promise<BalanceInput> {
  const lineRows = await exec
    .select({
      lineId: allocationLines.id,
      expenseId: allocations.expenseId,
      beneficiaryType: allocationLines.beneficiaryType,
      beneficiaryId: allocationLines.beneficiaryId,
      amount: allocationLines.amount,
      relationshipType: expenses.relationshipType,
      paidByPersonId: expenses.paidByPersonId,
    })
    .from(allocationLines)
    .innerJoin(allocations, eq(allocationLines.allocationId, allocations.id))
    .innerJoin(expenses, eq(allocations.expenseId, expenses.id))
    .where(isNull(allocations.supersededAt))
    .orderBy(asc(allocations.expenseId), asc(allocationLines.beneficiaryId));

  const groupLineIds = lineRows
    .filter((row) => row.beneficiaryType === 'group')
    .map((row) => row.lineId as AllocationLineId);
  const expansions = await listGroupExpansions(exec, groupLineIds);

  const expensesById = new Map<string, BalanceExpense>();
  const currentAllocationLines: BalanceAllocationLine[] = [];

  for (const row of lineRows) {
    expensesById.set(row.expenseId, {
      id: row.expenseId as ExpenseId,
      relationshipType: row.relationshipType as BalanceExpense['relationshipType'],
      paidByPersonId: row.paidByPersonId as PersonId,
    });
    const base = {
      expenseId: row.expenseId as ExpenseId,
      beneficiaryType: row.beneficiaryType as 'person' | 'group',
      beneficiaryId: row.beneficiaryId,
      amount: row.amount as Paise,
    };
    currentAllocationLines.push(
      row.beneficiaryType === 'group'
        ? {
            ...base,
            groupExpansion: expansions
              .filter((expansion) => expansion.allocationLineId === row.lineId)
              .map((expansion) => ({ personId: expansion.personId, amount: expansion.amount })),
          }
        : base,
    );
  }

  const settlementRows = await exec
    .select({
      counterpartyPersonId: settlements.counterpartyPersonId,
      amount: settlements.amount,
      direction: payments.direction,
    })
    .from(settlements)
    .innerJoin(payments, eq(settlements.paymentId, payments.id))
    .orderBy(asc(settlements.id));

  return {
    userPersonId,
    expenses: [...expensesById.values()],
    currentAllocationLines,
    settlements: settlementRows.map((row) => ({
      counterpartyPersonId: row.counterpartyPersonId as PersonId,
      direction: row.direction as 'debit' | 'credit',
      amount: row.amount as Paise,
    })),
  };
}

/** Every expense referenced by a pair's obligations — input to `obligationEvidenceStatus`. */
export async function listExpenseIdsWithCurrentAllocation(exec: Executor): Promise<ExpenseId[]> {
  const rows = await exec
    .select({ expenseId: allocations.expenseId })
    .from(allocations)
    .where(isNull(allocations.supersededAt));
  return rows.map((row) => row.expenseId as ExpenseId);
}

/* ===================================================================== reconciliation */

export async function insertReconciliationRun(
  exec: Executor,
  input: {
    readonly periodStart: Date;
    readonly periodEnd: Date;
    readonly totals: ReconciliationTotals;
    readonly discrepancies: readonly unknown[];
  },
): Promise<ReconciliationRunId> {
  const [row] = await exec
    .insert(reconciliationRuns)
    .values({
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      ledgerTotalOutflow: input.totals.ledgerTotalOutflow,
      ledgerTransfersTotal: input.totals.ledgerTransfersTotal,
      ledgerInvestmentsTotal: input.totals.ledgerInvestmentsTotal,
      ledgerSettlementsTotal: input.totals.ledgerSettlementsTotal,
      ledgerExplainedTotal: input.totals.ledgerExplainedTotal,
      ledgerUnexplainedTotal: input.totals.ledgerUnexplainedTotal,
      discrepancies: input.discrepancies,
    })
    .returning({ id: reconciliationRuns.id });
  return requireRow(row, 'reconciliation_runs').id as ReconciliationRunId;
}

/** The `ExpenseItem`s an item-based allocation draws its amounts from. */
export async function listExpenseItems(
  exec: Executor,
  expenseId: ExpenseId,
): Promise<Array<{ id: string; amount: Paise }>> {
  const rows = await exec
    .select({ id: expenseItems.id, amount: expenseItems.amount })
    .from(expenseItems)
    .where(eq(expenseItems.expenseId, expenseId))
    .orderBy(asc(expenseItems.id));
  return rows as Array<{ id: string; amount: Paise }>;
}

/**
 * Expenses carrying a **settlement-claim** manual note.
 *
 * One of the two signals behind `domain.obligationEvidenceStatus` — a human's recorded
 * belief that a debt was cleared some other way. Read-only, and never a substitute for a
 * real `Settlement` (ADR-0014, `invariants.md` #9b).
 *
 * Filters on `note_kind`, not on `type` alone. Matching every manual note would sweep up the
 * documenting note that ADR-0006 gives every externally-funded expense, and report those
 * obligations as believed-settled the moment they were recorded (ADR-0018).
 */
export async function listSettlementClaimExpenseIds(exec: Executor): Promise<ExpenseId[]> {
  const rows = await exec
    .select({
      type: evidence.type,
      noteKind: evidence.noteKind,
      linkedExpenseId: evidence.linkedExpenseId,
    })
    .from(evidence)
    // The WHERE clause narrows so the partial index can serve the query; `claimsSettlement`
    // below is what actually decides. Keeping the decision in `domain` means the SQL can
    // only ever be an optimisation, never a second, drifting copy of the rule.
    .where(
      and(
        eq(evidence.noteKind, SETTLEMENT_CLAIM_NOTE_KIND),
        sql`${evidence.linkedExpenseId} is not null`,
      ),
    );
  return rows
    .filter((row) =>
      claimsSettlement({
        type: row.type as EvidenceType,
        noteKind: row.noteKind as EvidenceNoteKind | null,
      }),
    )
    .map((row) => row.linkedExpenseId)
    .filter((value): value is string => value !== null) as ExpenseId[];
}

/** The most recent reconciliation run, for the Splitwise-discrepancy status signal. */
export async function getLatestReconciliationRun(
  exec: Executor,
): Promise<{ discrepancies: unknown } | null> {
  const [row] = await exec
    .select({ discrepancies: reconciliationRuns.discrepancies })
    .from(reconciliationRuns)
    .orderBy(desc(reconciliationRuns.runAt), desc(reconciliationRuns.id))
    .limit(1);
  return row ?? null;
}

/**
 * Flips an already-synced Splitwise expense to `stale` because **our** side changed.
 *
 * Distinct from `drifted`, which means Splitwise's side changed independently — the two
 * call for different next actions and are never conflated (ADR-0008, `lifecycle.md`).
 * Returns how many rows moved, so the caller can audit only when something actually did.
 */
export async function markSplitwiseExpenseStale(
  exec: Executor,
  expenseId: ExpenseId,
): Promise<string[]> {
  const rows = await exec
    .update(splitwiseExpenses)
    .set({ syncStatus: 'stale' })
    .where(
      and(eq(splitwiseExpenses.expenseId, expenseId), eq(splitwiseExpenses.syncStatus, 'synced')),
    )
    .returning({ id: splitwiseExpenses.id });
  return rows.map((row) => row.id);
}

/** Everything `domain.computeUnexplained` needs for one period. */
export async function loadReconciliationInput(
  exec: Executor,
  period: { readonly start: Date; readonly end: Date },
  userPersonId: PersonId,
): Promise<{
  payments: Array<{
    direction: 'debit' | 'credit';
    amount: Paise;
    counterpartyType: string;
    state: string;
  }>;
  settlements: Array<{ amount: Paise; direction: 'debit' | 'credit' }>;
  expenses: Array<{ netAmount: Paise; selfFunded: boolean }>;
}> {
  const paymentRows = await exec
    .select({
      direction: payments.direction,
      amount: payments.amount,
      counterpartyType: payments.counterpartyType,
      state: payments.state,
    })
    .from(payments)
    .where(
      and(
        sql`${payments.occurredAt} >= ${period.start}`,
        sql`${payments.occurredAt} < ${period.end}`,
      ),
    );

  const settlementRows = await exec
    .select({ amount: settlements.amount, direction: payments.direction })
    .from(settlements)
    .innerJoin(payments, eq(settlements.paymentId, payments.id))
    .where(
      and(
        sql`${payments.occurredAt} >= ${period.start}`,
        sql`${payments.occurredAt} < ${period.end}`,
      ),
    );

  // Gross amount and total adjustments per expense, so netAmount is computed in `domain`
  // rather than assembled in SQL.
  const expenseRows = await exec
    .select({
      id: expenses.id,
      amount: expenses.amount,
      paidByPersonId: expenses.paidByPersonId,
      state: expenses.state,
    })
    .from(expenses)
    .where(
      and(
        sql`${expenses.occurredAt} >= ${period.start}`,
        sql`${expenses.occurredAt} < ${period.end}`,
        sql`${expenses.state} in ('approved', 'allocated', 'ready_to_sync', 'synced', 'reconciled')`,
      ),
    );

  // Adjustments are gathered per expense and handed to `domain.netAmount`, rather than the
  // subtraction being repeated here. Re-implementing it would put the same financial rule in
  // two places, and this copy would not carry the negative-net guard the domain one does.
  const adjustmentRows = await exec
    .select({ expenseId: expenseAdjustments.originalExpenseId, amount: expenseAdjustments.amount })
    .from(expenseAdjustments);
  const adjustmentsByExpense = new Map<string, Paise[]>();
  for (const row of adjustmentRows) {
    const bucket = adjustmentsByExpense.get(row.expenseId) ?? [];
    bucket.push(row.amount as Paise);
    adjustmentsByExpense.set(row.expenseId, bucket);
  }

  return {
    payments: paymentRows as Array<{
      direction: 'debit' | 'credit';
      amount: Paise;
      counterpartyType: string;
      state: string;
    }>,
    settlements: settlementRows as Array<{ amount: Paise; direction: 'debit' | 'credit' }>,
    expenses: expenseRows.map((row) => ({
      netAmount: netAmount(row.amount as Paise, adjustmentsByExpense.get(row.id) ?? []),
      selfFunded: row.paidByPersonId === userPersonId,
    })),
  };
}

/* =========================================================================== helpers */

/** AI inference status, exposed so `services.decideInference` can persist a transition. */
export async function updateAiInferenceStatus(
  exec: Executor,
  inferenceId: string,
  status: AiInferenceStatus,
  decidedBy: string,
): Promise<void> {
  await exec.execute(
    sql`update ai_inferences set status = ${status}, decided_by = ${decidedBy}, decided_at = now() where id = ${inferenceId}`,
  );
}

function requireRow<T>(row: T | undefined, table: string): T {
  if (row === undefined) {
    throw new Error(`Expected ${table} to return the inserted row, got none.`);
  }
  return row;
}
