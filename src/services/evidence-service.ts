/**
 * Evidence ingestion — `data-flow.md` step 4, and the other half of the pipeline.
 *
 * ```
 * api ─▶ services.ingestEvidenceDocument ─▶ integrations/evidence-store.put
 *                                        ─▶ db.insertEvidence
 *        services.recordManualNote       ─▶ db.insertEvidence
 *        services.linkEvidence           ─▶ domain.assertEvidenceLinkOnce
 *                                        ─▶ db.updateEvidenceLinks
 * ```
 *
 * Phases 6–9 built the payment side end to end. `Evidence` is what arrives from the other
 * direction — a photographed receipt, a forwarded confirmation, a typed note — *"before,
 * during, or after classification"*, and for an externally-funded expense (ADR-0006) it is the
 * only source that will ever exist, because there is no `Payment` to match against.
 *
 * **This layer stores documents; it does not read them.** Turning a receipt image into a
 * `Receipt` with items and a total is extraction — `ai.parseReceipt` / `ai.extractReceiptItems`,
 * phase 11 — and nothing here calls a model, guesses a merchant, or reads an amount. Nor does
 * it match a document to a payment: a receipt gets a home because a human says so, or because
 * a later phase reads an amount off it and can be deterministic about the match. Ingestion
 * inventing a link would be the AI boundary crossed in the one place where there is no
 * confidence level to route on.
 */

import {
  assertEvidenceLinkOnce,
  parseEvidenceMediaType,
  validateEvidencePayload,
} from '../domain/index.js';
import type {
  EvidenceId,
  EvidenceMediaType,
  EvidenceNoteKind,
  EvidenceType,
  ExpenseId,
  PaymentId,
} from '../domain/index.js';
import {
  findEvidenceByStorageRef,
  getEvidenceById,
  getExpenseById,
  getPaymentById,
  insertEvidence,
  updateEvidenceLinks,
} from '../db/index.js';
import type { Database, EvidenceRow, Executor } from '../db/index.js';
import { isEvidenceStoreError } from '../integrations/evidence-store/index.js';
import type { EvidenceStore } from '../integrations/evidence-store/index.js';

import { runAudited, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';

/**
 * The largest document this system stores, in bytes.
 *
 * A phone photograph of a restaurant bill is a low single-digit number of megabytes and a
 * scanned multi-page PDF invoice is rarely more; 25 MB is generous for both. The cap lives
 * here rather than only at the transport because it is a property of what this system stores,
 * and a limit enforced at one entry point is a limit the next entry point forgets.
 */
export const MAX_EVIDENCE_DOCUMENT_BYTES = 25 * 1024 * 1024;

/** Evidence types that carry a document. A `manual_note` is typed text and has its own path. */
export type EvidenceDocumentType = Exclude<EvidenceType, 'manual_note'>;

/** What a document is attached to, if anything is known yet. */
export interface EvidenceLinkInput {
  readonly linkedPaymentId?: PaymentId | null;
  readonly linkedExpenseId?: ExpenseId | null;
}

export interface IngestEvidenceDocumentInput extends EvidenceLinkInput {
  readonly type: EvidenceDocumentType;
  readonly bytes: Uint8Array;
  /** As declared by the caller; validated against the accepted formats before anything else. */
  readonly mediaType: string;
  /** When the document was captured — the photograph's moment, not the upload's. */
  readonly capturedAt: Date;
  /** Text the caller already has (an email receipt's body). Extraction is phase 11. */
  readonly rawText?: string | null;
  readonly store: EvidenceStore;
  readonly audit: AuditMeta;
}

export interface IngestEvidenceResult {
  readonly evidenceId: EvidenceId;
  readonly storageRef: string;
  readonly mediaType: EvidenceMediaType;
  readonly byteSize: number;
  /**
   * `already_ingested` when these exact bytes were already stored against the same links.
   *
   * Not a duplicate-payment question — evidence carries no money, so a second row cannot
   * double-count anything (`invariants.md` #10 is about payments). It is about the review
   * queue and the reader: the same receipt uploaded twice from a share sheet should be the
   * one document it is, not two rows a human has to dismiss separately.
   */
  readonly outcome: 'ingested' | 'already_ingested';
}

/**
 * Stores a document and records the evidence row that points at it.
 *
 * The bytes are stored **before** the row is written, and deliberately: a content-addressed
 * store makes that safe to repeat, so the failure mode is an orphaned object nobody
 * references, not a row pointing at a document that was never written. Of the two, only the
 * second is a lie the ledger tells.
 */
export async function ingestEvidenceDocument(
  db: Database,
  input: IngestEvidenceDocumentInput,
): Promise<IngestEvidenceResult> {
  const mediaType = parseEvidenceMediaType(input.mediaType);
  assertWithinSizeLimit(input.bytes.byteLength);

  const links = {
    linkedPaymentId: input.linkedPaymentId ?? null,
    linkedExpenseId: input.linkedExpenseId ?? null,
  };
  await assertLinkTargetsExist(db, links);

  const stored = await withStoreErrorsTranslated(() => input.store.put(input.bytes, mediaType));

  const existing = (await findEvidenceByStorageRef(db, stored.storageRef)).find(
    (row) =>
      row.type === input.type &&
      row.linkedPaymentId === links.linkedPaymentId &&
      row.linkedExpenseId === links.linkedExpenseId,
  );
  if (existing !== undefined) {
    return {
      evidenceId: existing.id,
      storageRef: stored.storageRef,
      mediaType: stored.mediaType,
      byteSize: stored.byteSize,
      outcome: 'already_ingested',
    };
  }

  const draft = {
    type: input.type,
    noteKind: null,
    storageRef: stored.storageRef,
    mediaType: stored.mediaType,
    byteSize: stored.byteSize,
    rawText: input.rawText ?? null,
    capturedAt: input.capturedAt,
    ...links,
  };
  validateEvidencePayload(draft);

  const evidenceId = await runAudited(db, input.audit, async ({ exec, record }) => {
    const id = await insertEvidence(exec, draft);
    await record({
      entityType: 'evidence',
      entityId: id,
      action: 'create',
      newValue: {
        type: draft.type,
        storageRef: draft.storageRef,
        mediaType: draft.mediaType,
        byteSize: draft.byteSize,
        capturedAt: draft.capturedAt.toISOString(),
        linkedPaymentId: draft.linkedPaymentId,
        linkedExpenseId: draft.linkedExpenseId,
      },
    });
    return id;
  });

  return {
    evidenceId,
    storageRef: stored.storageRef,
    mediaType: stored.mediaType,
    byteSize: stored.byteSize,
    outcome: 'ingested',
  };
}

export interface RecordManualNoteInput extends EvidenceLinkInput {
  readonly text: string;
  /**
   * Documentation, or a claim that a debt was cleared — never inferred (ADR-0018).
   *
   * The caller says which, because the same row shape documents an externally-funded expense
   * and asserts that an obligation is settled, and guessing either way is a financial error.
   */
  readonly noteKind: EvidenceNoteKind;
  readonly capturedAt: Date;
  readonly audit: AuditMeta;
}

/**
 * Records a typed note.
 *
 * Not deduplicated, unlike a stored document. Two identical photographs are one document
 * uploaded twice; two identical notes are two things a person chose to say.
 */
export async function recordManualNote(
  db: Database,
  input: RecordManualNoteInput,
): Promise<EvidenceId> {
  const links = {
    linkedPaymentId: input.linkedPaymentId ?? null,
    linkedExpenseId: input.linkedExpenseId ?? null,
  };
  await assertLinkTargetsExist(db, links);

  const draft = {
    type: 'manual_note' as const,
    noteKind: input.noteKind,
    storageRef: null,
    mediaType: null,
    byteSize: null,
    rawText: input.text,
    capturedAt: input.capturedAt,
    ...links,
  };
  validateEvidencePayload(draft);

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const id = await insertEvidence(exec, draft);
    await record({
      entityType: 'evidence',
      entityId: id,
      action: 'create',
      newValue: {
        type: draft.type,
        noteKind: draft.noteKind,
        capturedAt: draft.capturedAt.toISOString(),
        linkedPaymentId: draft.linkedPaymentId,
        linkedExpenseId: draft.linkedExpenseId,
      },
    });
    return id;
  });
}

export interface LinkEvidenceInput extends EvidenceLinkInput {
  readonly evidenceId: EvidenceId;
  readonly audit: AuditMeta;
}

/**
 * Attaches evidence to a payment and/or an expense, once.
 *
 * This is the action the review queue offers for a document that arrived with no home. An
 * omitted side is left alone; a side already set may only be re-stated, never moved or cleared
 * (`domain.assertEvidenceLinkOnce`).
 *
 * A link that changes nothing returns before opening a transaction. An audited unit of work
 * that writes nothing is rolled back by design (`audit.ts`), and a no-op is not a failure.
 */
export async function linkEvidence(db: Database, input: LinkEvidenceInput): Promise<EvidenceRow> {
  const current = await requireEvidence(db, input.evidenceId);

  const proposed = {
    linkedPaymentId:
      input.linkedPaymentId === undefined ? current.linkedPaymentId : input.linkedPaymentId,
    linkedExpenseId:
      input.linkedExpenseId === undefined ? current.linkedExpenseId : input.linkedExpenseId,
  };
  assertEvidenceLinkOnce(current, proposed);

  if (
    proposed.linkedPaymentId === current.linkedPaymentId &&
    proposed.linkedExpenseId === current.linkedExpenseId
  ) {
    return current;
  }

  await assertLinkTargetsExist(db, proposed);

  await runAudited(db, input.audit, async ({ exec, record }) => {
    await updateEvidenceLinks(exec, current.id, proposed);
    await record({
      entityType: 'evidence',
      entityId: current.id,
      action: 'update',
      oldValue: {
        linkedPaymentId: current.linkedPaymentId,
        linkedExpenseId: current.linkedExpenseId,
      },
      newValue: proposed,
    });
  });

  return { ...current, ...proposed };
}

/** One evidence row. @throws ServiceError `ENTITY_NOT_FOUND` */
export async function getEvidence(db: Database, evidenceId: EvidenceId): Promise<EvidenceRow> {
  return requireEvidence(db, evidenceId);
}

export interface ReadEvidenceDocumentInput {
  readonly evidenceId: EvidenceId;
  readonly store: EvidenceStore;
}

export interface EvidenceDocumentResult {
  readonly evidence: EvidenceRow;
  readonly bytes: Uint8Array;
  readonly mediaType: EvidenceMediaType;
}

/**
 * Reads the document an evidence row points at.
 *
 * The ledger row and the document live in different systems on purpose
 * (`security-model.md`), which means "the row exists but the document does not" is a real
 * state — a database restored without its object store, a misconfigured root — and it is
 * reported rather than smoothed over into an empty response.
 */
export async function readEvidenceDocument(
  db: Database,
  input: ReadEvidenceDocumentInput,
): Promise<EvidenceDocumentResult> {
  const evidence = await requireEvidence(db, input.evidenceId);
  if (evidence.storageRef === null) {
    throw new ServiceError(
      'ENTITY_NOT_FOUND',
      `Evidence ${evidence.id} is a ${evidence.type} and has no stored document; its content ` +
        'is its text.',
      { evidenceId: evidence.id, type: evidence.type },
    );
  }

  const storageRef = evidence.storageRef;
  const document = await withStoreErrorsTranslated(() => input.store.get(storageRef));
  return { evidence, bytes: document.bytes, mediaType: document.mediaType };
}

/* ------------------------------------------------------------------------- internals */

async function requireEvidence(exec: Executor, evidenceId: EvidenceId): Promise<EvidenceRow> {
  const row = await getEvidenceById(exec, evidenceId);
  if (row === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No evidence with id ${evidenceId}.`, {
      evidenceId,
    });
  }
  return row;
}

function assertWithinSizeLimit(byteSize: number): void {
  if (byteSize > MAX_EVIDENCE_DOCUMENT_BYTES) {
    throw new ServiceError(
      'EVIDENCE_DOCUMENT_TOO_LARGE',
      `The document is ${byteSize} bytes; the limit is ${MAX_EVIDENCE_DOCUMENT_BYTES}. A ` +
        'photographed bill or a scanned invoice is comfortably under it, and something larger ' +
        'is more likely a mistake than a receipt.',
      { byteSize: String(byteSize), limit: String(MAX_EVIDENCE_DOCUMENT_BYTES) },
    );
  }
}

/**
 * Refuses a link to something that does not exist.
 *
 * The foreign keys would refuse it too, but as an opaque constraint violation from inside a
 * transaction. Checking first means the caller is told which of the two ids was wrong.
 */
async function assertLinkTargetsExist(
  exec: Executor,
  links: { readonly linkedPaymentId: PaymentId | null; readonly linkedExpenseId: ExpenseId | null },
): Promise<void> {
  if (
    links.linkedPaymentId !== null &&
    (await getPaymentById(exec, links.linkedPaymentId)) === null
  ) {
    throw new ServiceError(
      'ENTITY_NOT_FOUND',
      `No payment with id ${links.linkedPaymentId} to attach this evidence to.`,
      { linkedPaymentId: links.linkedPaymentId },
    );
  }
  if (
    links.linkedExpenseId !== null &&
    (await getExpenseById(exec, links.linkedExpenseId)) === null
  ) {
    throw new ServiceError(
      'ENTITY_NOT_FOUND',
      `No expense with id ${links.linkedExpenseId} to attach this evidence to.`,
      { linkedExpenseId: links.linkedExpenseId },
    );
  }
}

/**
 * Turns a storage failure into an orchestration failure.
 *
 * `src/api` maps `ServiceError` codes to statuses and knows nothing about the store, which is
 * what keeps the choice of adapter invisible above this layer. A malformed ref is deliberately
 * *not* translated: it means a row in this database holds something this system could not have
 * written, which is a fault to surface as one rather than to dress up as a missing document.
 */
async function withStoreErrorsTranslated<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isEvidenceStoreError(error)) {
      if (error.code === 'DOCUMENT_NOT_STORED') {
        throw new ServiceError('ENTITY_NOT_FOUND', error.message, error.details);
      }
      if (error.code === 'STORE_UNAVAILABLE') {
        throw new ServiceError('EVIDENCE_STORE_UNAVAILABLE', error.message, error.details);
      }
    }
    throw error;
  }
}
