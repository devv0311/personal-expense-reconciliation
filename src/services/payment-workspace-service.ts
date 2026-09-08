/**
 * The payment workspace — every posted movement, what already explains it, and the two
 * authoring paths that were missing entirely: entering a movement by hand, and saying what a
 * payment's counterparty is.
 *
 * Closes audit rows 02 (manual/cash movements), 06 (no service classified an imported payment
 * as an investment or a transfer) and 36 (no general payments listing, so no drill-through
 * from a waterfall term to its contributing records).
 *
 * The arithmetic rule holds exactly as everywhere else: this layer calls
 * `domain.explainedAmount` and `domain.isDuplicateRepresentation` and adds nothing of its own.
 * "Unexplained" is a domain conclusion surfaced here, never a second definition written in SQL
 * or in a screen.
 */

import {
  NON_SPEND_COUNTERPARTY_TYPES,
  SUPPORTED_CURRENCY,
  asId,
  explainedAmount,
  isDuplicateRepresentation,
} from '../domain/index.js';
import type {
  AccountId,
  CashFlowCategory,
  CashFlowState,
  ImportBatchId,
  Paise,
  PaymentChannel,
  PaymentCounterpartyType,
  PaymentDirection,
  PaymentId,
  PaymentReferenceType,
  PaymentState,
} from '../domain/index.js';
import {
  applyPaymentCounterparty,
  countImportBatches,
  countPaymentsForWorkspace,
  getAccountById,
  getImportBatchById,
  getMerchantById,
  getPaymentById,
  getPaymentWorkspaceRow,
  getPersonById,
  insertImportBatch,
  insertPayment,
  listCounterpartyCandidates,
  listImportBatches,
  listPaymentsForWorkspace,
} from '../db/index.js';
import type { Database, Executor, PaymentWorkspaceFilter } from '../db/index.js';

import { runAudited, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';

/** Names the batch a hand-entered movement belongs to, so its provenance is never blank. */
export const MANUAL_ENTRY_SOURCE_CHANNEL = 'manual_entry';

/* ========================================================================== the list */

export interface PaymentWorkspaceItem {
  readonly id: PaymentId;
  readonly accountId: AccountId;
  readonly accountName: string;
  readonly importBatchId: ImportBatchId;
  readonly amount: Paise;
  readonly currency: string;
  readonly direction: PaymentDirection;
  readonly occurredAt: Date;
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
  readonly expenseLinkTotal: Paise;
  readonly settlementTotal: Paise;
  readonly adjustmentTotal: Paise;
  readonly evidenceCount: number;
  readonly expenseLinkCount: number;
  readonly settlementCount: number;
  /** `domain.explainedAmount` — never recomputed here, and never in `web/`. */
  readonly explainedTotal: Paise;
  /** `amount - explainedTotal`, from the same domain function. Zero is not "verified". */
  readonly unexplainedTotal: Paise;
  /** A confirmed copy of another movement, which no total may count (`invariants.md` #10). */
  readonly isDuplicateRepresentation: boolean;
}

export interface ListPaymentsInput extends PaymentWorkspaceFilter {
  /**
   * Narrow to movements the ledger cannot yet account for.
   *
   * Applied here rather than in SQL because "explained" is `domain.explainedAmount`'s answer,
   * and a `WHERE` clause approximating it would be a second definition of the one concept
   * this system is built to keep honest.
   */
  readonly onlyUnexplained?: boolean;
}

export interface ListPaymentsResult {
  readonly payments: readonly PaymentWorkspaceItem[];
  /**
   * How many rows match the filter in the whole ledger, not how many were returned.
   *
   * Audit row 32 recorded the failure this avoids: *"The displayed count is the loaded subset,
   * not a guaranteed full-ledger count."* When `onlyUnexplained` is on, the total is the
   * matching page's own length plus whatever remains — see `filteredTotalIsExact`.
   */
  readonly total: number;
  /**
   * False when `onlyUnexplained` narrowed the page after the count was taken, so a surface can
   * say "at least N" instead of asserting a total it cannot stand behind.
   */
  readonly filteredTotalIsExact: boolean;
  readonly limit: number;
  readonly offset: number;
}

export async function listPaymentsWorkspace(
  db: Executor,
  input: ListPaymentsInput = {},
): Promise<ListPaymentsResult> {
  const { onlyUnexplained, ...filter } = input;
  const limit = filter.limit ?? 100;
  const offset = filter.offset ?? 0;
  const [rows, total] = await Promise.all([
    listPaymentsForWorkspace(db, { ...filter, limit, offset }),
    countPaymentsForWorkspace(db, filter),
  ]);

  const items = rows.map(toWorkspaceItem);
  const filtered =
    onlyUnexplained === true ? items.filter((item) => item.unexplainedTotal > 0n) : items;

  return {
    payments: filtered,
    total,
    filteredTotalIsExact: onlyUnexplained !== true,
    limit,
    offset,
  };
}

export async function getPaymentWorkspaceItem(
  db: Executor,
  paymentId: PaymentId,
): Promise<PaymentWorkspaceItem> {
  const row = await getPaymentWorkspaceRow(db, paymentId);
  if (row === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', 'No such payment.', { paymentId });
  }
  return toWorkspaceItem(row);
}

function toWorkspaceItem(
  row: Awaited<ReturnType<typeof listPaymentsForWorkspace>>[number],
): PaymentWorkspaceItem {
  const explainedTotal = explainedAmount({
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
  const duplicate = isDuplicateRepresentation({
    state: row.state,
    ignoredReason: row.ignoredReason,
  });
  return {
    ...row,
    explainedTotal,
    // A confirmed duplicate is not an unexplained movement — the money it represents was
    // already counted once, and reporting it as a gap would invent a hole in the account.
    unexplainedTotal: (duplicate ? 0n : row.amount - explainedTotal) as Paise,
    isDuplicateRepresentation: duplicate,
  };
}

/* =========================================================== the counterparty editor */

export interface SetPaymentCounterpartyInput {
  readonly paymentId: PaymentId;
  readonly counterpartyType: PaymentCounterpartyType;
  /**
   * The merchant, person or owned account on the other side. Required for every type except
   * `unknown`, which is the honest answer when nobody knows yet.
   */
  readonly counterpartyId?: string | null;
  readonly audit: AuditMeta;
}

/**
 * Records what a payment's counterparty is.
 *
 * The audit's row 06 named this precisely: *"No service was found that classifies an ordinary
 * imported payment as `investment_instrument`."* Normalization only ever writes `merchant` (a
 * deterministic alias hit) and classification only ever writes `internal_account` (a paired
 * self-transfer). Neither can say "this SIP debit is an investment", which is the one fact
 * that keeps it out of spending (`invariants.md` #7, ADR-0011).
 *
 * This is a **person's** decision, not an inference. It refuses to move a payment that is
 * already explained by an expense link into a non-spend type, because that would silently
 * orphan the expense it funded.
 */
export async function setPaymentCounterparty(
  db: Database,
  input: SetPaymentCounterpartyInput,
): Promise<{ readonly paymentId: PaymentId; readonly counterpartyType: PaymentCounterpartyType }> {
  return runAudited(db, input.audit, async ({ exec, record }) => {
    const payment = await getPaymentById(exec, input.paymentId);
    if (payment === null) {
      throw new ServiceError('ENTITY_NOT_FOUND', 'No such payment.', {
        paymentId: input.paymentId,
      });
    }

    const counterpartyId = input.counterpartyId ?? null;
    await assertCounterpartyExists(exec, input.counterpartyType, counterpartyId);

    const nonSpend = (NON_SPEND_COUNTERPARTY_TYPES as readonly string[]).includes(
      input.counterpartyType,
    );
    if (nonSpend) {
      const workspaceRow = await getPaymentWorkspaceRow(exec, input.paymentId);
      if (workspaceRow !== null && workspaceRow.expenseLinkCount > 0) {
        throw new ServiceError(
          'PRECONDITION_FAILED',
          `This payment already funds ${workspaceRow.expenseLinkCount} expense(s). A transfer ` +
            'or an investment can never be linked to an expense (`invariants.md` #7), so the ' +
            'link has to be removed before the payment can be reclassified this way — ' +
            'otherwise an expense would keep pointing at money the ledger no longer treats ' +
            'as spending.',
          { paymentId: input.paymentId },
        );
      }
    }

    await applyPaymentCounterparty(exec, input.paymentId, {
      counterpartyType: input.counterpartyType,
      counterpartyId,
    });
    await record({
      entityType: 'payment',
      entityId: input.paymentId,
      action: 'update',
      oldValue: {
        counterpartyType: payment.counterpartyType,
        counterpartyId: payment.counterpartyId,
      },
      newValue: { counterpartyType: input.counterpartyType, counterpartyId },
    });

    return { paymentId: input.paymentId, counterpartyType: input.counterpartyType };
  });
}

async function assertCounterpartyExists(
  exec: Executor,
  counterpartyType: PaymentCounterpartyType,
  counterpartyId: string | null,
): Promise<void> {
  if (counterpartyType === 'unknown') {
    if (counterpartyId !== null) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        'An unknown counterparty cannot also name one.',
        { field: 'counterpartyId' },
      );
    }
    return;
  }
  if (counterpartyType === 'investment_instrument') {
    // The tag alone is the classification. This system deliberately does not model
    // instruments — ADR-0011 puts holdings and valuation explicitly out of scope — so there is
    // no row for `counterparty_id` to point at, and inventing one would imply a portfolio the
    // ledger does not keep. What the SIP was *called* belongs in the payment's own immutable
    // narration, which already has it.
    if (counterpartyId !== null) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        'An investment is recognised by its classification, not by an instrument row: this ' +
          'system tracks that the money left spending, never what it bought (ADR-0011). ' +
          'Leave "counterpartyId" out.',
        { field: 'counterpartyId' },
      );
    }
    return;
  }
  if (counterpartyId === null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `A "${counterpartyType}" counterparty has to name who or what it is.`,
      { field: 'counterpartyId' },
    );
  }
  if (counterpartyType === 'merchant') {
    const merchant = await getMerchantById(exec, asId<'merchant'>(counterpartyId));
    if (merchant === null) {
      throw new ServiceError('ENTITY_NOT_FOUND', 'No such merchant.', { counterpartyId });
    }
    return;
  }
  if (counterpartyType === 'person') {
    const person = await getPersonById(exec, asId<'person'>(counterpartyId));
    if (person === null) {
      throw new ServiceError('ENTITY_NOT_FOUND', 'No such person.', { counterpartyId });
    }
    return;
  }
  const account = await getAccountById(exec, asId<'account'>(counterpartyId));
  if (account === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', 'No such account.', { counterpartyId });
  }
}

/** Everything a counterparty editor can offer. A read. */
export async function listPaymentCounterpartyOptions(
  db: Executor,
): Promise<Awaited<ReturnType<typeof listCounterpartyCandidates>>> {
  return listCounterpartyCandidates(db);
}

/* ==================================================== hand-entered cash movements */

export interface RecordManualPaymentInput {
  readonly accountId: AccountId;
  readonly amount: Paise;
  readonly direction: PaymentDirection;
  readonly occurredAt: Date;
  /** What the movement was; becomes the immutable `raw_description`. */
  readonly description: string;
  readonly channel?: PaymentChannel;
  readonly externalReference?: string | null;
  readonly referenceType?: PaymentReferenceType | null;
  readonly audit: AuditMeta;
}

export interface RecordManualPaymentResult {
  readonly paymentId: PaymentId;
  readonly importBatchId: ImportBatchId;
}

/**
 * Records a movement nobody exported — cash out of a wallet, a note handed over, a transfer
 * a statement has not yet reflected.
 *
 * It is still SOURCE data, so it is still written through an `ImportBatch`: a payment with no
 * provenance is a payment nobody can later explain, and `payments.import_batch_id` is
 * `not null` precisely to make that impossible. The batch's `source_channel` says plainly that
 * a person typed it (`manual_entry`), so a reader can tell a keyed movement from an imported
 * one forever after.
 *
 * The row lands at `imported`, exactly like a CSV row, and takes the same normalization →
 * classification path. Nothing here classifies, links, or explains anything.
 */
export async function recordManualPayment(
  db: Database,
  input: RecordManualPaymentInput,
): Promise<RecordManualPaymentResult> {
  if (input.amount <= 0n) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'A movement has a positive magnitude; which way it went is `direction`, not a sign.',
      { field: 'amount' },
    );
  }
  const description = input.description.trim();
  if (description.length === 0) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'A hand-entered movement needs a description — it becomes the immutable narration ' +
        'everything downstream reads.',
      { field: 'description' },
    );
  }

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const account = await getAccountById(exec, input.accountId);
    if (account === null) {
      throw new ServiceError('ENTITY_NOT_FOUND', 'No such account.', {
        accountId: input.accountId,
      });
    }
    if (account.currency !== SUPPORTED_CURRENCY) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        `This build does arithmetic in ${SUPPORTED_CURRENCY} only (ADR-0012).`,
        { currency: account.currency },
      );
    }

    const importBatchId = await insertImportBatch(exec, {
      sourceChannel: MANUAL_ENTRY_SOURCE_CHANNEL,
      fileReference: null,
      // No content hash: there is no file to recognise on a second import, and a hash of the
      // typed text would make two genuinely separate ₹200 cash payments look like one.
      contentHash: null,
      parserVersion: null,
      rowCount: 1,
    });
    // `insertPayment` always lands a row at `imported`, exactly like a CSV row — this path
    // adds no shortcut through normalization or classification.
    const paymentId = await insertPayment(exec, {
      accountId: input.accountId,
      importBatchId,
      amount: input.amount,
      currency: account.currency,
      direction: input.direction,
      occurredAt: input.occurredAt,
      rawDescription: description,
      channel: input.channel ?? (account.type === 'cash' ? 'cash' : 'other'),
      externalReference: emptyToNull(input.externalReference),
      referenceType: input.referenceType ?? null,
      sourceSystem: MANUAL_ENTRY_SOURCE_CHANNEL,
    });

    await record({
      entityType: 'import_batch',
      entityId: importBatchId,
      action: 'create',
      newValue: { sourceChannel: MANUAL_ENTRY_SOURCE_CHANNEL, rowCount: 1 },
    });
    await record({
      entityType: 'payment',
      entityId: paymentId,
      action: 'create',
      newValue: {
        accountId: input.accountId,
        amount: input.amount.toString(),
        direction: input.direction,
        occurredAt: input.occurredAt.toISOString(),
        rawDescription: description,
        enteredByHand: true,
      },
    });

    return { paymentId, importBatchId };
  });
}

/* ===================================================================== import history */

export interface ImportHistoryResult {
  readonly batches: Awaited<ReturnType<typeof listImportBatches>>;
  readonly total: number;
}

/** What has been loaded into this ledger, newest first (audit row 01). */
export async function listImportHistory(
  db: Executor,
  options: { readonly limit?: number; readonly offset?: number } = {},
): Promise<ImportHistoryResult> {
  const [batches, total] = await Promise.all([
    listImportBatches(db, options),
    countImportBatches(db),
  ]);
  return { batches, total };
}

export async function getImportBatch(
  db: Executor,
  importBatchId: ImportBatchId,
): Promise<NonNullable<Awaited<ReturnType<typeof getImportBatchById>>>> {
  const batch = await getImportBatchById(db, importBatchId);
  if (batch === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', 'No such import batch.', { importBatchId });
  }
  return batch;
}

/* --------------------------------------------------------------------------- internals */

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
