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

import { and, asc, desc, eq, exists, inArray, isNull, sql } from 'drizzle-orm';

import type {
  AiInferenceStatus,
  AiInferenceType,
  AuditAction,
  AuditableEntityType,
  ConfidenceLevel,
  EvidenceNoteKind,
  EvidenceType,
  ExpenseRelationshipType,
  ExpenseState,
  PaymentChannel,
  PaymentCounterpartyType,
  PaymentState,
} from '../domain/enums.js';
import type {
  AiInferenceId,
  AllocationId,
  AllocationLineId,
  AuditEventId,
  ExpenseId,
  ImportBatchId,
  GroupId,
  MerchantId,
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
  aiInferences,
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
  merchantAliases,
  merchants,
  paymentExpenseLinks,
  payments,
  people,
  reconciliationRuns,
  settlements,
  splitwiseExpenses,
  users,
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
  return (
    exec
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
      // Ordered by the monotonic sequence, never by `occurred_at`: that column resolves to
      // milliseconds, so events written back-to-back tie and the order becomes arbitrary.
      .orderBy(asc(auditEvents.sequence))
  );
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

export interface ExpenseDraft {
  readonly description: string | null;
  readonly amount: Paise;
  readonly currency: string;
  readonly occurredAt: Date;
  readonly relationshipType: ExpenseRelationshipType;
  readonly category: string | null;
  readonly paidByPersonId: PersonId;
  readonly state: ExpenseState;
}

/**
 * Creates an expense.
 *
 * The caller supplies `state`, because an expense's starting state is a decision (`proposed`
 * for a fresh proposal), not a property of this table. `amount` is written exactly once, here:
 * there is no update path for it anywhere in this file (`invariants.md` #6).
 */
export async function insertExpense(exec: Executor, draft: ExpenseDraft): Promise<ExpenseId> {
  const [row] = await exec
    .insert(expenses)
    .values({
      description: draft.description,
      amount: draft.amount,
      currency: draft.currency,
      occurredAt: draft.occurredAt,
      relationshipType: draft.relationshipType,
      category: draft.category,
      paidByPersonId: draft.paidByPersonId,
      state: draft.state,
    })
    .returning({ id: expenses.id });
  return requireRow(row, 'expenses').id as ExpenseId;
}

/**
 * Rewrites the two fields `CLASSIFIED` means (`lifecycle.md`): `relationship_type` and
 * `category`.
 *
 * Deliberately narrow. It exists for `decideInference`'s `modify` path — a human correcting a
 * proposal before approving it — and touches nothing else: not `amount`, not
 * `paid_by_person_id`, not `state`, each of which has its own path or none at all.
 */
export async function updateExpenseClassification(
  exec: Executor,
  expenseId: ExpenseId,
  next: { readonly relationshipType: ExpenseRelationshipType; readonly category: string | null },
): Promise<void> {
  await exec
    .update(expenses)
    .set({
      relationshipType: next.relationshipType,
      category: next.category,
      updatedAt: new Date(),
    })
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

export interface PaymentExpenseLinkDraft {
  readonly paymentId: PaymentId;
  readonly expenseId: ExpenseId;
  readonly amount: Paise;
}

/**
 * Attributes part of a payment to an expense.
 *
 * The caller validates the shared explanation budget first
 * (`domain.validatePaymentExplanationBudget`): links and settlements draw on one payment's
 * amount, and this function does not know that rule.
 */
export async function insertPaymentExpenseLink(
  exec: Executor,
  draft: PaymentExpenseLinkDraft,
): Promise<void> {
  await exec.insert(paymentExpenseLinks).values({
    paymentId: draft.paymentId,
    expenseId: draft.expenseId,
    amount: draft.amount,
  });
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
  /** Read by classification, which copies it onto the `Expense` it proposes. */
  readonly currency: string;
  readonly direction: 'debit' | 'credit';
  readonly counterpartyType: string;
  /** Polymorphic per `counterpartyType`; a `MerchantId` when normalization resolved one. */
  readonly counterpartyId: string | null;
  readonly state: PaymentState;
  /** Why this payment is `ignored`, e.g. `duplicate_of:<id>`. Null unless `state` is `ignored`. */
  readonly ignoredReason: string | null;
  readonly occurredAt: Date;
  readonly externalReference: string | null;
  readonly accountId: string;
  /** Read by normalization to refine it (`domain.refineChannel`). */
  readonly channel: string;
  /** The evidence normalization refines `channel` from (ADR-0020). */
  readonly referenceType: string | null;
  /** Matched against `merchant_aliases.raw_pattern`, canonicalized first. */
  readonly rawDescription: string;
}

export async function getPaymentById(
  exec: Executor,
  paymentId: PaymentId,
): Promise<PaymentRow | null> {
  const [row] = await exec
    .select({
      id: payments.id,
      amount: payments.amount,
      currency: payments.currency,
      direction: payments.direction,
      counterpartyType: payments.counterpartyType,
      counterpartyId: payments.counterpartyId,
      state: payments.state,
      ignoredReason: payments.ignoredReason,
      occurredAt: payments.occurredAt,
      externalReference: payments.externalReference,
      accountId: payments.accountId,
      channel: payments.channel,
      referenceType: payments.referenceType,
      rawDescription: payments.rawDescription,
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
      currency: payments.currency,
      direction: payments.direction,
      counterpartyType: payments.counterpartyType,
      counterpartyId: payments.counterpartyId,
      state: payments.state,
      ignoredReason: payments.ignoredReason,
      occurredAt: payments.occurredAt,
      externalReference: payments.externalReference,
      accountId: payments.accountId,
      channel: payments.channel,
      referenceType: payments.referenceType,
      rawDescription: payments.rawDescription,
    })
    .from(payments)
    .where(eq(payments.externalReference, externalReference))
    .orderBy(asc(payments.occurredAt), asc(payments.id));
  return rows as PaymentRow[];
}

/**
 * Payments eligible for normalization: those still at `imported`.
 *
 * The state filter is the idempotency rule (ADR-0021), not an optimisation — a payment that
 * has already been normalized must not be offered again, or a re-run would silently rewrite
 * a counterparty someone may have since acted on. `ignored` rows are excluded by the same
 * filter, which is what keeps a duplicate discarded at import from being resurrected.
 *
 * The `(occurred_at, id)` ordering ties for same-day rows and is settled by a random UUID —
 * the same shape as two defects this project has already fixed. It is harmless *here* and
 * deliberately left alone: each payment is normalized independently of every other, so
 * processing order cannot change any stored result. Only the order of `normalizedPaymentIds`
 * in the return value varies, and nothing depends on it. If a future change ever makes one
 * payment's normalization depend on another's, this ordering stops being safe.
 */
export async function listPaymentsAwaitingNormalization(
  exec: Executor,
  importBatchId?: ImportBatchId,
): Promise<PaymentRow[]> {
  const rows = await exec
    .select({
      id: payments.id,
      amount: payments.amount,
      currency: payments.currency,
      direction: payments.direction,
      counterpartyType: payments.counterpartyType,
      counterpartyId: payments.counterpartyId,
      state: payments.state,
      ignoredReason: payments.ignoredReason,
      occurredAt: payments.occurredAt,
      externalReference: payments.externalReference,
      accountId: payments.accountId,
      channel: payments.channel,
      referenceType: payments.referenceType,
      rawDescription: payments.rawDescription,
    })
    .from(payments)
    .where(
      importBatchId === undefined
        ? eq(payments.state, 'imported')
        : and(eq(payments.state, 'imported'), eq(payments.importBatchId, importBatchId)),
    )
    .orderBy(asc(payments.occurredAt), asc(payments.id));
  return rows as PaymentRow[];
}

/**
 * The merchant an already-canonical alias key resolves to, if any.
 *
 * Exact equality only — never a prefix, substring, or similarity match. `raw_pattern` stores
 * the canonical key produced by `domain.merchantAliasKey`, so the caller must canonicalize
 * before calling; passing a raw description here will simply not match.
 */
export async function findMerchantByAliasKey(
  exec: Executor,
  aliasKey: string,
): Promise<MerchantId | null> {
  const [row] = await exec
    .select({ merchantId: merchantAliases.merchantId })
    .from(merchantAliases)
    .where(eq(merchantAliases.rawPattern, aliasKey));
  return row === undefined ? null : (row.merchantId as MerchantId);
}

/** The catalogued merchant behind a resolved counterparty, for display and for context. */
export async function getMerchantById(
  exec: Executor,
  merchantId: MerchantId,
): Promise<{ id: MerchantId; canonicalName: string; defaultCategory: string | null } | null> {
  const [row] = await exec
    .select({
      id: merchants.id,
      canonicalName: merchants.canonicalName,
      defaultCategory: merchants.defaultCategory,
    })
    .from(merchants)
    .where(eq(merchants.id, merchantId));
  return row === undefined
    ? null
    : {
        id: row.id as MerchantId,
        canonicalName: row.canonicalName,
        defaultCategory: row.defaultCategory,
      };
}

/**
 * Writes the DERIVED results of normalization and moves the payment to `normalized`.
 *
 * Touches no SOURCE column: `amount`, `occurred_at`, `raw_description` and `account_id` are
 * write-once (`invariants.md` #4) and are deliberately absent from this update.
 */
export async function applyPaymentNormalization(
  exec: Executor,
  paymentId: PaymentId,
  next: {
    readonly channel: PaymentChannel;
    readonly counterpartyType: PaymentCounterpartyType;
    readonly counterpartyId: MerchantId | null;
  },
): Promise<void> {
  await exec
    .update(payments)
    .set({
      channel: next.channel,
      counterpartyType: next.counterpartyType,
      counterpartyId: next.counterpartyId,
      state: 'normalized',
    })
    .where(eq(payments.id, paymentId));
}

/**
 * A payment offered to classification, plus the one fact eligibility needs that the row
 * itself does not carry.
 */
export interface ClassifiablePaymentRow extends PaymentRow {
  /** Whether a `classify_transaction` inference already references this payment. */
  readonly hasClassificationInference: boolean;
}

/**
 * Payments classification may look at: those at `normalized`.
 *
 * A **pre-filter, not the rule**. `domain.classificationEligibility` is the authority on what
 * may be classified and by which leg, and it re-checks everything this query filters on — so a
 * row that slips through here is skipped with a reason rather than classified by accident.
 * The state filter is here because scanning every payment ever imported to discard all but the
 * normalized ones is a query, not a rule.
 *
 * `hasClassificationInference` comes back as a correlated `exists`, so eligibility does not
 * need a second round-trip per payment.
 *
 * Ordering ties on `(occurred_at, id)` exactly as normalization's does, and is safe for the
 * same reason: each payment is classified independently of every other. The one exception is
 * the self-transfer pairing, which reads its counter-leg by external reference rather than by
 * position in this list, so it cannot depend on the order either.
 */
export async function listPaymentsAwaitingClassification(
  exec: Executor,
  importBatchId?: ImportBatchId,
): Promise<ClassifiablePaymentRow[]> {
  const rows = await exec
    .select({
      id: payments.id,
      amount: payments.amount,
      currency: payments.currency,
      direction: payments.direction,
      counterpartyType: payments.counterpartyType,
      counterpartyId: payments.counterpartyId,
      state: payments.state,
      ignoredReason: payments.ignoredReason,
      occurredAt: payments.occurredAt,
      externalReference: payments.externalReference,
      accountId: payments.accountId,
      channel: payments.channel,
      referenceType: payments.referenceType,
      rawDescription: payments.rawDescription,
      // Drizzle's `exists` helper, not a raw fragment: a raw one renders the outer
      // `payments.id` unqualified, where it silently binds to `ai_inferences.id` instead and
      // the correlation quietly evaluates to false for every row.
      hasClassificationInference: exists(
        exec
          .select({ one: sql`1` })
          .from(aiInferences)
          .where(
            and(
              eq(aiInferences.inferenceType, 'classify_transaction'),
              eq(aiInferences.inputRefType, 'payment'),
              eq(aiInferences.inputRefId, payments.id),
            ),
          ),
      ),
    })
    .from(payments)
    .where(
      importBatchId === undefined
        ? eq(payments.state, 'normalized')
        : and(eq(payments.state, 'normalized'), eq(payments.importBatchId, importBatchId)),
    )
    .orderBy(asc(payments.occurredAt), asc(payments.id));
  return rows as ClassifiablePaymentRow[];
}

/**
 * Writes a classified counterparty onto an already-normalized payment.
 *
 * Separate from `applyPaymentNormalization`, which also sets `state = 'normalized'`. Here the
 * state is deliberately untouched: a transfer stays at `normalized` forever
 * (`lifecycle.md`, `invariants.md` #7), and a payment that is about to be explained moves to
 * `linked` through `updatePaymentState` as its own audited step.
 *
 * Touches no SOURCE column, exactly as normalization does not.
 */
export async function applyPaymentCounterparty(
  exec: Executor,
  paymentId: PaymentId,
  next: {
    readonly counterpartyType: PaymentCounterpartyType;
    readonly counterpartyId: string | null;
  },
): Promise<void> {
  await exec
    .update(payments)
    .set({ counterpartyType: next.counterpartyType, counterpartyId: next.counterpartyId })
    .where(eq(payments.id, paymentId));
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

/* =============================================================================== people */

/**
 * The single user's `Person`, which is who "the user" means everywhere else.
 *
 * `domain-model.md` maps a `User` to exactly one `Person`; this is that mapping, read once per
 * operation that needs to know whether a payer or a counterparty is the user themselves.
 */
export async function getPrimaryUserPerson(
  exec: Executor,
): Promise<{ personId: PersonId; displayName: string } | null> {
  const [row] = await exec
    .select({ personId: users.personId, displayName: people.displayName })
    .from(users)
    .innerJoin(people, eq(people.id, users.personId))
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(1);
  return row === undefined
    ? null
    : { personId: row.personId as PersonId, displayName: row.displayName };
}

/** Everyone not archived, oldest first — the roster a proposal may name a counterparty from. */
export async function listPeople(
  exec: Executor,
): Promise<Array<{ id: PersonId; displayName: string }>> {
  const rows = await exec
    .select({ id: people.id, displayName: people.displayName })
    .from(people)
    .where(isNull(people.archivedAt))
    .orderBy(asc(people.createdAt), asc(people.id));
  return rows as Array<{ id: PersonId; displayName: string }>;
}

/** One person, for confirming a proposal named someone who actually exists. */
export async function getPersonById(
  exec: Executor,
  personId: PersonId,
): Promise<{ id: PersonId; displayName: string; archivedAt: Date | null } | null> {
  const [row] = await exec
    .select({ id: people.id, displayName: people.displayName, archivedAt: people.archivedAt })
    .from(people)
    .where(eq(people.id, personId));
  return row === undefined
    ? null
    : { id: row.id as PersonId, displayName: row.displayName, archivedAt: row.archivedAt };
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

/* ======================================================================= AI inferences */

export interface AiInferenceDraft {
  readonly inferenceType: AiInferenceType;
  /** What the inference was run on — `'payment'` for a classification. */
  readonly inputRefType: string;
  readonly inputRefId: string;
  /** The **validated** proposal, never the raw model response (`ai-boundary.md`, gate 1). */
  readonly proposedOutput: unknown;
  readonly confidence: ConfidenceLevel;
  readonly modelProvider: string | null;
  readonly modelName: string | null;
  readonly promptVersion: string | null;
}

export interface AiInferenceRow {
  readonly id: AiInferenceId;
  readonly inferenceType: string;
  readonly inputRefType: string;
  readonly inputRefId: string;
  readonly proposedOutput: unknown;
  readonly confidence: string;
  readonly status: AiInferenceStatus;
  readonly modelProvider: string | null;
  readonly modelName: string | null;
  readonly promptVersion: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly resultingRecordType: string | null;
  readonly resultingRecordId: string | null;
}

const AI_INFERENCE_COLUMNS = {
  id: aiInferences.id,
  inferenceType: aiInferences.inferenceType,
  inputRefType: aiInferences.inputRefType,
  inputRefId: aiInferences.inputRefId,
  proposedOutput: aiInferences.proposedOutput,
  confidence: aiInferences.confidence,
  status: aiInferences.status,
  modelProvider: aiInferences.modelProvider,
  modelName: aiInferences.modelName,
  promptVersion: aiInferences.promptVersion,
  decidedBy: aiInferences.decidedBy,
  decidedAt: aiInferences.decidedAt,
  resultingRecordType: aiInferences.resultingRecordType,
  resultingRecordId: aiInferences.resultingRecordId,
} as const;

/**
 * Records one proposal. `status` defaults to `pending` at the database, which is the point:
 * an inference is a proposal until `services.decideInference` says otherwise, and there is no
 * way to insert one that is already accepted.
 */
export async function insertAiInference(
  exec: Executor,
  draft: AiInferenceDraft,
): Promise<AiInferenceId> {
  const [row] = await exec
    .insert(aiInferences)
    .values({
      inferenceType: draft.inferenceType,
      inputRefType: draft.inputRefType,
      inputRefId: draft.inputRefId,
      proposedOutput: draft.proposedOutput,
      confidence: draft.confidence,
      modelProvider: draft.modelProvider,
      modelName: draft.modelName,
      promptVersion: draft.promptVersion,
    })
    .returning({ id: aiInferences.id });
  return requireRow(row, 'ai_inferences').id as AiInferenceId;
}

export async function getAiInferenceById(
  exec: Executor,
  inferenceId: AiInferenceId,
): Promise<AiInferenceRow | null> {
  const [row] = await exec
    .select(AI_INFERENCE_COLUMNS)
    .from(aiInferences)
    .where(eq(aiInferences.id, inferenceId));
  return row === undefined ? null : (row as AiInferenceRow);
}

/**
 * The classification inference for one payment, newest first.
 *
 * At most one exists today — a payment that already carries one is not eligible for
 * classification again (`domain.classificationEligibility`) — but the query is written to
 * return the newest rather than to assume uniqueness, because `superseded` (`lifecycle.md`)
 * will make several rows per payment normal as soon as re-classification exists.
 */
export async function findClassificationInferenceByPayment(
  exec: Executor,
  paymentId: PaymentId,
): Promise<AiInferenceRow | null> {
  const [row] = await exec
    .select(AI_INFERENCE_COLUMNS)
    .from(aiInferences)
    .where(
      and(
        eq(aiInferences.inferenceType, 'classify_transaction'),
        eq(aiInferences.inputRefType, 'payment'),
        eq(aiInferences.inputRefId, paymentId),
      ),
    )
    .orderBy(desc(aiInferences.createdAt), desc(aiInferences.id))
    .limit(1);
  return row === undefined ? null : (row as AiInferenceRow);
}

/**
 * Points an inference at the record it produced.
 *
 * Written twice on the expense path, and that is deliberate: once when classification creates
 * the DERIVED `Expense` (so the proposal and the row it produced are findable from each
 * other), and once at the decision, which is when that row becomes authoritative (ADR-0026).
 */
export async function attachAiInferenceRecord(
  exec: Executor,
  inferenceId: AiInferenceId,
  recordType: 'expense' | 'settlement',
  recordId: string,
): Promise<void> {
  await exec
    .update(aiInferences)
    .set({ resultingRecordType: recordType, resultingRecordId: recordId })
    .where(eq(aiInferences.id, inferenceId));
}

/**
 * Persists the decision that took an inference out of `pending`.
 *
 * `decidedBy` is a person or a `Rule` (`rule:<id>`), never the model — `invariants.md` #17,
 * enforced by `domain.parseDecisionActor` before this is called. The status transition itself
 * is checked by `domain.assertAiInferenceTransition`; this function only writes.
 */
export async function recordAiInferenceDecision(
  exec: Executor,
  inferenceId: AiInferenceId,
  decision: { readonly status: AiInferenceStatus; readonly decidedBy: string },
): Promise<void> {
  await exec
    .update(aiInferences)
    .set({ status: decision.status, decidedBy: decision.decidedBy, decidedAt: new Date() })
    .where(eq(aiInferences.id, inferenceId));
}

/* =========================================================================== helpers */

function requireRow<T>(row: T | undefined, table: string): T {
  if (row === undefined) {
    throw new Error(`Expected ${table} to return the inserted row, got none.`);
  }
  return row;
}
