/**
 * Receipt extraction — the operation phase 10 deliberately left undone (`services/evidence-
 * service.ts`: "this layer stores documents; it does not read them").
 *
 * ```
 * services.extractReceipt  ─▶ ai.parseReceipt / ai.extractReceiptItems ─▶ two AIInference (pending)
 *                           ─▶ domain.assertReceiptDraftInformative     (gate 2)
 *                           ─▶ db (Receipt + ReceiptItems, unconfirmed)
 * services.confirmReceipt  ─▶ confirmed_by_user = true, inferences → accepted
 * services.correctReceipt  ─▶ overwrite fields/items, confirmed_by_user = true, inferences → modified
 * services.getReceipt      ─▶ read, with both discrepancies and any candidate match computed fresh
 * ```
 *
 * `Receipt` is DERIVED, not APPROVED-classified (ADR-0036) — so unlike `classifyPayment`, there
 * is no `decideInference`-shaped gate between a proposal and a written row. Extraction writes
 * directly, the same way classification's DERIVED `Expense` already exists before anyone
 * approves it; confirmation and correction are what `confirmed_by_user` and the human-editable
 * fields exist for.
 */

import {
  assertAiInferenceTransition,
  assertReceiptDraftInformative,
  findCandidatePaymentMatches,
  isDomainError,
  isReceiptExtractableEvidenceType,
  lowerConfidence,
  merchantAliasKey,
  parseDecisionActor,
  receiptItemsSubtotalDiscrepancy,
  receiptPaymentDiscrepancy,
} from '../domain/index.js';
import type {
  ConfidenceLevel,
  EvidenceId,
  MerchantId,
  Paise,
  PaymentId,
  ReceiptId,
} from '../domain/index.js';
import { isAiContractError } from '../ai/index.js';
import type { AiService, Inference, ReceiptDraft, ReceiptItemDraft } from '../ai/index.js';
import {
  attachAiInferenceRecord,
  findMerchantByAliasKey,
  getEvidenceById,
  getPaymentById,
  getReceiptByEvidenceId,
  getReceiptById,
  insertAiInference,
  insertReceiptItems,
  insertReceipt as insertReceiptRow,
  listAiInferencesByResultingRecord,
  listReceiptItemsByReceipt,
  listUnlinkedDebitPaymentsNear,
  recordAiInferenceDecision,
  replaceReceiptItems,
  updateReceiptExtraction,
} from '../db/index.js';
import type { Database, EvidenceRow, ReceiptItemRow, ReceiptRow } from '../db/index.js';

import { runAudited, type AuditContext, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';

/** How far a receipt's captured date may sit from a candidate payment's, either way. */
const CANDIDATE_MATCH_WINDOW_DAYS = 3;

/* ------------------------------------------------------------------------------- extraction */

export interface ExtractReceiptInput {
  readonly evidenceId: EvidenceId;
  readonly ai: AiService;
  readonly audit: AuditMeta;
}

/** One payment `Receipt.total` matches exactly, within the date window (ADR-0037). */
export interface CandidatePaymentMatch {
  readonly paymentId: PaymentId;
  readonly amount: Paise;
  readonly occurredAt: Date;
  readonly description: string;
}

/** A `Receipt`, its items, and what is surfaced about it — never written to a column. */
export interface ReceiptView {
  readonly receipt: ReceiptRow;
  readonly items: readonly ReceiptItemRow[];
  /** `items` summed vs `receipt.subtotal`. `null` when there is nothing to compare. */
  readonly itemsSubtotalDiscrepancy: Paise | null;
  /** `receipt.total` vs the linked payment's amount. `null` when either is absent. */
  readonly paymentDiscrepancy: Paise | null;
  /** Only ever non-empty when the evidence has no linked payment yet (ADR-0037). */
  readonly candidateMatches: readonly CandidatePaymentMatch[];
}

export interface ExtractedReceipt {
  readonly outcome: 'extracted';
  readonly view: ReceiptView;
}

/** The model answered, and its answer was not a usable proposal. Nothing was written. */
export interface RejectedExtraction {
  readonly outcome: 'rejected';
  readonly reason: string;
  /** `AiContractError.code` (gate 1) or `DomainError.code` (gate 2). */
  readonly code: string;
}

export type ExtractReceiptOutcome = ExtractedReceipt | RejectedExtraction;

/**
 * Extracts a `Receipt` and its `ReceiptItem`s from one piece of evidence.
 *
 * Eligibility (is this evidence a receipt at all, does one already exist for it) is checked
 * before either model is asked, and fails loudly with `ServiceError` — the caller chose this
 * one evidence row deliberately, so an ineligible request is the caller's mistake, not a fact
 * about a proposal. A rejected *proposal* (gate 1 or gate 2) is reported as an outcome instead,
 * matching `classifyPayment`'s "the model said something invalid" shape, because nothing was
 * written either way and there is nothing here for a caller to have gotten wrong.
 *
 * @throws ServiceError `ENTITY_NOT_FOUND` when the evidence does not exist.
 * @throws ServiceError `PRECONDITION_FAILED` when it is not receipt-eligible, or already has a
 *   `Receipt` — re-extraction is not offered; correct the existing one instead.
 */
export async function extractReceipt(
  db: Database,
  input: ExtractReceiptInput,
): Promise<ExtractReceiptOutcome> {
  const evidence = await requireEvidence(db, input.evidenceId);

  if (!isReceiptExtractableEvidenceType(evidence.type)) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Evidence ${evidence.id} is a "${evidence.type}", which is not a document a receipt can ` +
        'be extracted from.',
      { evidenceId: evidence.id, type: evidence.type },
    );
  }
  if ((await getReceiptByEvidenceId(db, evidence.id)) !== null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Evidence ${evidence.id} already has a Receipt. Correct it with services.correctReceipt ` +
        'rather than extracting a second time.',
      { evidenceId: evidence.id },
    );
  }

  const evidenceInput = {
    evidenceType: evidence.type,
    // Guaranteed non-null: every receipt-extractable type carries a stored document
    // (`domain.validateEvidencePayload`), unlike a manual note.
    mediaType: evidence.mediaType!,
    rawText: evidence.rawText,
    capturedAt: evidence.capturedAt,
  };

  try {
    const [parsed, extracted] = await Promise.all([
      input.ai.parseReceipt(evidenceInput),
      input.ai.extractReceiptItems(evidenceInput),
    ]);
    // Gate 1 already ran inside each operation. Gate 2: is this draft worth recording at all?
    assertReceiptDraftInformative(parsed.proposedOutput);
    const confidence = lowerConfidence(parsed.confidence, extracted.confidence);

    const view = await runAudited(db, input.audit, async (ctx) => {
      const receiptId = await writeReceiptRows(ctx, {
        evidence,
        draft: parsed.proposedOutput,
        items: extracted.proposedOutput,
        confidence,
      });
      await storeInference(ctx, evidence.id, receiptId, parsed, input.audit);
      await storeInference(ctx, evidence.id, receiptId, extracted, input.audit);

      const receipt = requireLoaded(await getReceiptById(ctx.exec, receiptId), receiptId);
      const loadedItems = await listReceiptItemsByReceipt(ctx.exec, receiptId);
      return buildReceiptView(ctx.exec, evidence, receipt, loadedItems);
    });

    return { outcome: 'extracted', view };
  } catch (error) {
    const rejection = asExtractionRejection(error);
    if (rejection === null) throw error;
    return rejection;
  }
}

interface WriteReceiptRowsInput {
  readonly evidence: EvidenceRow;
  readonly draft: ReceiptDraft;
  readonly items: readonly ReceiptItemDraft[];
  readonly confidence: ConfidenceLevel;
}

async function writeReceiptRows(
  ctx: AuditContext,
  input: WriteReceiptRowsInput,
): Promise<ReceiptId> {
  const { evidence, draft, items, confidence } = input;
  const merchantId =
    draft.merchantHint === null ? null : await resolveMerchant(ctx.exec, draft.merchantHint);

  const receiptId = await insertReceiptRow(ctx.exec, {
    evidenceId: evidence.id,
    merchantId,
    subtotal: draft.subtotal,
    tax: draft.tax,
    total: draft.total,
    currency: draft.currency,
    extractionConfidence: confidence,
    extractedAt: new Date(),
  });
  await insertReceiptItems(ctx.exec, receiptId, items);
  await ctx.record({
    entityType: 'receipt',
    entityId: receiptId,
    action: 'create',
    newValue: {
      evidenceId: evidence.id,
      merchantId,
      subtotal: draft.subtotal?.toString() ?? null,
      tax: draft.tax?.toString() ?? null,
      total: draft.total?.toString() ?? null,
      currency: draft.currency,
      extractionConfidence: confidence,
      itemCount: items.length,
    },
  });
  return receiptId;
}

async function storeInference(
  ctx: AuditContext,
  evidenceId: EvidenceId,
  receiptId: ReceiptId,
  inference: Inference<unknown>,
  audit: AuditMeta,
): Promise<void> {
  const inferenceId = await insertAiInference(ctx.exec, {
    inferenceType: inference.inferenceType,
    inputRefType: 'evidence',
    inputRefId: evidenceId,
    // JSONB has no bigint representation, and a ReceiptDraft/ReceiptItemDraft[] carries Paise
    // fields directly — unlike TransactionClassification, which never needed this. Nothing
    // reads this column back into a typed proposal (the Receipt row itself is authoritative),
    // so a lossless string round-trip is all traceability requires.
    proposedOutput: toJsonSafe(inference.proposedOutput),
    confidence: inference.confidence,
    modelProvider: inference.modelInfo.provider,
    modelName: inference.modelInfo.model,
    promptVersion: inference.modelInfo.promptVersion,
  });
  await attachAiInferenceRecord(ctx.exec, inferenceId, 'receipt', receiptId);
  await ctx.record({
    entityType: 'ai_inference',
    entityId: inferenceId,
    action: 'create',
    newValue: {
      inferenceType: inference.inferenceType,
      status: 'pending',
      inputRefType: 'evidence',
      inputRefId: evidenceId,
      confidence: inference.confidence,
    },
    reason: `Produced Receipt ${receiptId} by ${audit.source}.`,
  });
}

/** Resolves a receipt's merchant hint deterministically, or leaves it null (this phase's scope decision). */
async function resolveMerchant(exec: Database, merchantHint: string): Promise<MerchantId | null> {
  return findMerchantByAliasKey(exec, merchantAliasKey(merchantHint));
}

/** Turns the two "this proposal is not usable" failures into a recorded outcome. */
function asExtractionRejection(error: unknown): RejectedExtraction | null {
  if (isAiContractError(error)) {
    return { outcome: 'rejected', reason: error.message, code: error.code };
  }
  if (isDomainError(error) && error.code === 'RECEIPT_DRAFT_INVALID') {
    return { outcome: 'rejected', reason: error.message, code: error.code };
  }
  return null;
}

/* --------------------------------------------------------------------------- confirm/correct */

export interface ConfirmReceiptInput {
  readonly receiptId: ReceiptId;
  readonly audit: AuditMeta;
}

/**
 * Confirms a `Receipt` as extracted.
 *
 * A no-op, returned without opening a transaction, when it is already confirmed — the same
 * shape `linkEvidence` uses for a link that changes nothing, and for the same reason: an
 * audited unit of work that writes nothing is rolled back by design, and a no-op is not a
 * failure.
 */
export async function confirmReceipt(
  db: Database,
  input: ConfirmReceiptInput,
): Promise<ReceiptView> {
  parseDecisionActor(input.audit.actor);
  const receipt = requireLoaded(await getReceiptById(db, input.receiptId), input.receiptId);
  const evidence = await requireEvidence(db, receipt.evidenceId);

  if (receipt.confirmedByUser) {
    const items = await listReceiptItemsByReceipt(db, receipt.id);
    return buildReceiptView(db, evidence, receipt, items);
  }

  return runAudited(db, input.audit, async (ctx) => {
    await updateReceiptExtraction(ctx.exec, receipt.id, { confirmedByUser: true });
    await ctx.record({
      entityType: 'receipt',
      entityId: receipt.id,
      action: 'update',
      oldValue: { confirmedByUser: false },
      newValue: { confirmedByUser: true },
    });
    await transitionPendingInferences(ctx, receipt.id, 'accepted', input.audit.actor);

    const confirmed = requireLoaded(await getReceiptById(ctx.exec, receipt.id), receipt.id);
    const items = await listReceiptItemsByReceipt(ctx.exec, receipt.id);
    return buildReceiptView(ctx.exec, evidence, confirmed, items);
  });
}

export interface ReceiptCorrection {
  readonly merchantId?: MerchantId | null;
  readonly subtotal?: Paise | null;
  readonly tax?: Paise | null;
  readonly total?: Paise | null;
  readonly currency?: string;
  /** Present replaces the whole item set; absent leaves the extracted items as they are. */
  readonly items?: readonly ReceiptItemDraft[];
}

export interface CorrectReceiptInput {
  readonly receiptId: ReceiptId;
  readonly correction: ReceiptCorrection;
  readonly audit: AuditMeta;
}

/**
 * Applies a human's correction to a `Receipt` — the "or corrected by the user" half of
 * `domain-model.md`'s lifecycle text. Confirms it in the same act: a human who just fixed a
 * figure has, by construction, looked at the row.
 *
 * Only fields present in `correction` change; an absent field is left as extraction left it.
 * `items`, when present, replaces the whole set — a `ReceiptItem` carries no identity a caller
 * could otherwise refer back to (`db.replaceReceiptItems`).
 */
export async function correctReceipt(
  db: Database,
  input: CorrectReceiptInput,
): Promise<ReceiptView> {
  parseDecisionActor(input.audit.actor);
  const receipt = requireLoaded(await getReceiptById(db, input.receiptId), input.receiptId);
  const evidence = await requireEvidence(db, receipt.evidenceId);
  const { correction } = input;

  return runAudited(db, input.audit, async (ctx) => {
    await updateReceiptExtraction(ctx.exec, receipt.id, {
      ...correctionFields(correction),
      confirmedByUser: true,
    });
    await ctx.record({
      entityType: 'receipt',
      entityId: receipt.id,
      action: 'update',
      oldValue: {
        merchantId: receipt.merchantId,
        subtotal: receipt.subtotal?.toString() ?? null,
        tax: receipt.tax?.toString() ?? null,
        total: receipt.total?.toString() ?? null,
        currency: receipt.currency,
        confirmedByUser: receipt.confirmedByUser,
      },
      // `correction.items`, when present, is recorded in its own event below — it carries
      // Paise fields a jsonb column cannot hold as bigint, and belongs with the item-count
      // fact rather than duplicated here.
      newValue: {
        merchantId: correction.merchantId,
        subtotal: correction.subtotal?.toString(),
        tax: correction.tax?.toString(),
        total: correction.total?.toString(),
        currency: correction.currency,
        confirmedByUser: true,
      },
      reason: `Corrected by ${input.audit.actor}.`,
    });

    if (correction.items !== undefined) {
      await replaceReceiptItems(ctx.exec, receipt.id, correction.items);
      await ctx.record({
        entityType: 'receipt',
        entityId: receipt.id,
        action: 'update',
        newValue: { itemCount: correction.items.length },
        reason: 'Item set replaced by correction.',
      });
    }

    await transitionPendingInferences(ctx, receipt.id, 'modified', input.audit.actor);

    const corrected = requireLoaded(await getReceiptById(ctx.exec, receipt.id), receipt.id);
    const items = await listReceiptItemsByReceipt(ctx.exec, receipt.id);
    return buildReceiptView(ctx.exec, evidence, corrected, items);
  });
}

/**
 * Moves every still-`pending` inference behind a `Receipt` to `target`.
 *
 * "Still pending" is deliberate (ADR-0036): a correction made after an earlier confirmation
 * leaves that confirmation's `accepted` inferences alone rather than trying to re-decide an
 * already-terminal `AIInference` — `lifecycle.md`'s transition table has no edge out of
 * `accepted`/`modified`, and there is nothing wrong with that; the receipt row's own audit
 * trail is what records the later correction.
 */
async function transitionPendingInferences(
  ctx: AuditContext,
  receiptId: ReceiptId,
  target: 'accepted' | 'modified',
  actor: string,
): Promise<void> {
  const inferences = await listAiInferencesByResultingRecord(ctx.exec, 'receipt', receiptId);
  for (const inference of inferences) {
    if (inference.status !== 'pending') continue;
    assertAiInferenceTransition(inference.status, target);
    await recordAiInferenceDecision(ctx.exec, inference.id, { status: target, decidedBy: actor });
    await ctx.record({
      entityType: 'ai_inference',
      entityId: inference.id,
      action: 'update',
      oldValue: { status: 'pending' },
      newValue: { status: target, decidedBy: actor },
    });
  }
}

/* ------------------------------------------------------------------------------------- read */

export async function getReceipt(db: Database, receiptId: ReceiptId): Promise<ReceiptView> {
  const receipt = requireLoaded(await getReceiptById(db, receiptId), receiptId);
  const evidence = await requireEvidence(db, receipt.evidenceId);
  const items = await listReceiptItemsByReceipt(db, receiptId);
  return buildReceiptView(db, evidence, receipt, items);
}

/**
 * The `Receipt` extracted from one piece of evidence, with its view computed — or `null` when
 * extraction has not happened yet.
 *
 * `services.listReviewQueue`'s way of enriching an `unmatched_evidence` item once an amount
 * exists to enrich it with (ADR-0035's "matching needs an amount", finally answered).
 */
export async function getReceiptViewByEvidenceId(
  db: Database,
  evidenceId: EvidenceId,
): Promise<ReceiptView | null> {
  const receipt = await getReceiptByEvidenceId(db, evidenceId);
  if (receipt === null) return null;
  const evidence = await requireEvidence(db, evidenceId);
  const items = await listReceiptItemsByReceipt(db, receipt.id);
  return buildReceiptView(db, evidence, receipt, items);
}

/** Computes the two surfaced discrepancies and any candidate match — never written anywhere. */
async function buildReceiptView(
  exec: Database,
  evidence: EvidenceRow,
  receipt: ReceiptRow,
  items: readonly ReceiptItemRow[],
): Promise<ReceiptView> {
  const itemsSubtotalDiscrepancy = receiptItemsSubtotalDiscrepancy(receipt.subtotal, items);

  let paymentDiscrepancy: Paise | null = null;
  let candidateMatches: readonly CandidatePaymentMatch[] = [];

  if (evidence.linkedPaymentId !== null) {
    const payment = await getPaymentById(exec, evidence.linkedPaymentId);
    paymentDiscrepancy = receiptPaymentDiscrepancy(receipt.total, payment?.amount ?? null);
  } else if (receipt.total !== null) {
    const from = addDays(evidence.capturedAt, -CANDIDATE_MATCH_WINDOW_DAYS);
    const to = addDays(evidence.capturedAt, CANDIDATE_MATCH_WINDOW_DAYS);
    const candidates = await listUnlinkedDebitPaymentsNear(exec, {
      amount: receipt.total,
      from,
      to,
    });
    const matched = findCandidatePaymentMatches(
      { total: receipt.total, capturedAt: evidence.capturedAt },
      candidates.map((payment) => ({
        paymentId: payment.id,
        amount: payment.amount,
        occurredAt: payment.occurredAt,
      })),
      { windowDays: CANDIDATE_MATCH_WINDOW_DAYS },
    );
    const byId = new Map(candidates.map((payment) => [payment.id, payment]));
    candidateMatches = matched.map((match) => {
      const payment = byId.get(match.paymentId as PaymentId)!;
      return {
        paymentId: payment.id,
        amount: payment.amount,
        occurredAt: payment.occurredAt,
        description: payment.rawDescription,
      };
    });
  }

  return { receipt, items, itemsSubtotalDiscrepancy, paymentDiscrepancy, candidateMatches };
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/* ------------------------------------------------------------------------------------ loaders */

async function requireEvidence(exec: Database, evidenceId: EvidenceId): Promise<EvidenceRow> {
  const evidence = await getEvidenceById(exec, evidenceId);
  if (evidence === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No evidence with id ${evidenceId}.`, {
      evidenceId,
    });
  }
  return evidence;
}

function requireLoaded<T>(value: T | null, receiptId: ReceiptId): T {
  if (value === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No Receipt with id ${receiptId}.`, { receiptId });
  }
  return value;
}

/**
 * `correction` without `items`, keeping only the keys the caller actually supplied.
 *
 * `updateReceiptExtraction` distinguishes "field present with a value" from "field absent" by
 * `in`, so this cannot simply list every key — that would make every field present, and an
 * omitted correction field would overwrite the existing value with `undefined` instead of
 * leaving it alone.
 */
function correctionFields(correction: ReceiptCorrection): Omit<ReceiptCorrection, 'items'> {
  const fields: Record<string, unknown> = {};
  for (const key of ['merchantId', 'subtotal', 'tax', 'total', 'currency'] as const) {
    if (key in correction) fields[key] = correction[key];
  }
  return fields;
}

/** A `Paise`-bearing proposal, made safe for a `jsonb` column — exact strings, never a float. */
function toJsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === 'bigint' ? entry.toString() : entry,
    ),
  ) as unknown;
}
